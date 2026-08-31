import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { openDb } from "./db.js";
import { buildServer } from "./server.js";
import { dbPath, pidPath, socketPath, stateDir } from "./paths.js";
import { getGitHubToken, syncAllActivePrs, syncPr, syncCampaign, expireStaleClaims } from "./github.js";
import { checkHookHealth } from "./hook-health.js";
import { killAllLiveSessions, resumeSessionsOnBoot } from "./terminals.js";
import { remapSessionIds, sessionIdsInTree, type PaneNode } from "./layout-tree.js";

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
  await app.listen({ path: socketPath });
  console.log(`daemon listening on ${socketPath} (db: ${dbPath})`);

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
    await app.close();
    db.close();
    rmSync(socketPath, { force: true });
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
