import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { openDb } from "./db.js";
import { buildServer } from "./server.js";
import { dbPath, internalSocketPath, pidPath, socketPath, stateDir, tcpTokenPath } from "./paths.js";
import { getGitHubToken, syncAllActivePrs, syncPr, syncCampaign, expireStaleClaims } from "./github.js";
import { checkHookHealth } from "./hook-health.js";
import { killAllLiveSessions, reconcileHost, remapLayouts, resumeSessionsOnBoot, watchLocalExecs } from "./terminals.js";
import { readOrCreateTcpToken } from "./tcp-token.js";
import { startDispatcher } from "./dispatcher.js";
import { hydrateHosts, selfHeartbeat } from "./fleet.js";
import { HEARTBEAT_INTERVAL_MS, startHeartbeatLoop } from "./heartbeat.js";
import { hostId } from "./host.js";

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

  watchLocalExecs(db);
  hydrateHosts(db);

  const token = getGitHubToken();
  const app = await buildServer(db, token ? syncPr : null, token ? syncCampaign : null);
  await app.listen({ path: internalSocketPath });
  console.log(`daemon listening on ${internalSocketPath} (db: ${dbPath})`);

  // Resume after the server is listening so that the SessionStart hook fired
  // by each resumed session can reach /hook-confirm immediately. If sessions
  // are spawned before listen(), the hook's fire-and-forget POST gets ENOENT
  // and hook_confirmed_at stays NULL, triggering a false "hooks not wired"
  // warning 60 s later.
  // Points every pane that referenced a now-stale session at whatever
  // resumeSessionsOnBoot did with it: the resumed session's new id, or null
  // (empty, relaunchable pane) if it couldn't be resumed.
  remapLayouts(db, resumeSessionsOnBoot(db));

  // This daemon's own sessions get the same resource tracking as those on
  // remote hosts, from a local heartbeat that never leaves the process.
  selfHeartbeat(db);
  const selfHeartbeatTimer = setInterval(() => {
    const hb = selfHeartbeat(db);
    void reconcileHost(db, hb, hb.bootId).catch(console.error);
  }, HEARTBEAT_INTERVAL_MS);

  // Optional: expose this daemon over TCP (token-gated) so another machine's
  // daemon can use it as its remote peer — how the always-on box acts as the
  // shared source of truth. Bind host has no implicit wide-open default:
  // exposure requires BESIEGE_TCP_HOST to be set explicitly (typically this
  // machine's Tailscale IP).
  const tcpPort = process.env.BESIEGE_TCP_PORT;
  let tcpApp: Awaited<ReturnType<typeof buildServer>> | null = null;
  if (tcpPort) {
    const tcpHost = process.env.BESIEGE_TCP_HOST ?? "127.0.0.1";
    const tcpTokens = [readOrCreateTcpToken(), process.env.BESIEGE_PRIMARY_TOKEN].filter((t): t is string => !!t);
    tcpApp = await buildServer(db, token ? syncPr : null, token ? syncCampaign : null, tcpTokens);
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
  console.log(`daemon dispatcher listening on ${socketPath} (host id: ${hostId})`);

  // A follower reports what it's running to the primary, which is what
  // lets the primary place sessions here and show them everywhere.
  const heartbeat = process.env.BESIEGE_PRIMARY_URL
    ? startHeartbeatLoop(process.env.BESIEGE_PRIMARY_URL, process.env.BESIEGE_PRIMARY_TOKEN)
    : null;

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
    clearInterval(selfHeartbeatTimer);
    heartbeat?.stop();
    killAllLiveSessions(db); // don't leave orphaned zombie shells behind
    await heartbeat?.sendFinal();
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
