import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { openDb } from "./db.js";
import { buildServer } from "./server.js";
import { dbPath, internalSocketPath, pidPath, socketPath, stateDir, tcpTokenPath } from "./paths.js";
import { getGitHubToken, syncAllActivePrs, syncPr, syncCampaign, expireStaleClaims } from "./github.js";
import { checkHookHealth } from "./hook-health.js";
import { killAllLiveSessions, resumeSessionsOnBoot } from "./terminals.js";
import { remapSessionIds, sessionIdsInTree, type PaneNode } from "./layout-tree.js";
import { readOrCreateTcpToken } from "./tcp-token.js";
import { startDispatcher } from "./dispatcher.js";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSingleInstanceLock(): void {
  mkdirSync(stateDir, { recursive: true });

  if (existsSync(pidPath)) {
    const existingPid = Number(readFileSync(pidPath, "utf8").trim());
    if (Number.isInteger(existingPid) && processIsAlive(existingPid)) {
      console.error(`daemon already running (pid ${existingPid}, state dir ${stateDir})`);
      process.exit(1);
    }
    // Stale pidfile from an unclean shutdown — clear it and any leftover socket.
    rmSync(pidPath, { force: true });
  }

  rmSync(socketPath, { force: true });
  rmSync(internalSocketPath, { force: true });
  writeFileSync(pidPath, String(process.pid));
}

async function main() {
  acquireSingleInstanceLock();

  const db = openDb();
  db.prepare("INSERT INTO daemon_startups (started_at) VALUES (?)").run(new Date().toISOString());

  const resumeIdMap = resumeSessionsOnBoot(db);
  if (resumeIdMap.size > 0) {
    // Point every pane that referenced a now-stale session at whatever
    // resumeSessionsOnBoot did with it: the resumed session's new id, or
    // null (empty, relaunchable pane) if it couldn't be resumed.
    const layoutRows = db.prepare("SELECT id, layout_tree FROM terminal_layouts").all() as {
      id: number;
      layout_tree: string;
    }[];
    const updateTree = db.prepare("UPDATE terminal_layouts SET layout_tree = ? WHERE id = ?");
    for (const row of layoutRows) {
      const tree = JSON.parse(row.layout_tree) as PaneNode;
      if (!sessionIdsInTree(tree).some((id) => resumeIdMap.has(id))) continue;
      updateTree.run(JSON.stringify(remapSessionIds(tree, resumeIdMap)), row.id);
    }
  }

  const token = getGitHubToken();
  const app = await buildServer(db, token ? syncPr : null, token ? syncCampaign : null);
  await app.listen({ path: internalSocketPath });
  console.log(`daemon listening on ${internalSocketPath} (db: ${dbPath})`);

  // Optional: expose this daemon over TCP (token-gated) so another machine's
  // daemon can use it as its remote peer — how the always-on box acts as the
  // shared source of truth. Bind host has no implicit wide-open default:
  // exposure requires BESIEGE_TCP_HOST to be set explicitly (typically this
  // machine's Tailscale IP).
  const tcpPort = process.env.BESIEGE_TCP_PORT;
  let tcpApp: Awaited<ReturnType<typeof buildServer>> | null = null;
  if (tcpPort) {
    const tcpHost = process.env.BESIEGE_TCP_HOST ?? "127.0.0.1";
    const tcpToken = readOrCreateTcpToken();
    tcpApp = await buildServer(db, token ? syncPr : null, token ? syncCampaign : null, tcpToken);
    await tcpApp.listen({ port: Number(tcpPort), host: tcpHost });
    console.log(`daemon also listening on tcp://${tcpHost}:${tcpPort} (token: ${tcpTokenPath})`);
  }

  // Always-on: fronts `socketPath` (the address every client already
  // connects to), forwarding to a configured remote peer when reachable or
  // to this machine's own app above otherwise. A no-op passthrough to the
  // local app when BESIEGE_PRIMARY_URL isn't set.
  const dispatcher = startDispatcher({
    publicSocketPath: socketPath,
    internalSocketPath,
    primaryUrl: process.env.BESIEGE_PRIMARY_URL,
    primaryToken: process.env.BESIEGE_PRIMARY_TOKEN,
  });
  console.log(`daemon dispatcher listening on ${socketPath}`);

  if (token) {
    console.log("GitHub token found — starting sync loop");
    syncAllActivePrs(db).catch(console.error);
    setInterval(() => {
      syncAllActivePrs(db).catch(console.error);
      expireStaleClaims(db);
      checkHookHealth(db);
    }, 60_000);
  } else {
    console.log("No GitHub token — PR sync disabled (set GITHUB_TOKEN or run gh auth login)");
    setInterval(() => {
      expireStaleClaims(db);
      checkHookHealth(db);
    }, 60_000);
  }

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    killAllLiveSessions(db); // don't leave orphaned zombie shells behind
    dispatcher.close();
    await app.close();
    if (tcpApp) await tcpApp.close();
    db.close();
    rmSync(socketPath, { force: true });
    rmSync(internalSocketPath, { force: true });
    rmSync(pidPath, { force: true });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
