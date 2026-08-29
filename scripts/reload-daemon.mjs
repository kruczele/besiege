#!/usr/bin/env node
// `pnpm daemon:reload` — stops any running daemon and starts a fresh one
// from current source. Unlike `pnpm web` (which leaves an already-running
// daemon alone), this always replaces it — which ends any live agent
// terminal sessions it was tracking (the daemon's own shutdown path kills
// them all). Mostly useful for a hard restart (new dependency, stuck state,
// or the current daemon wasn't running via `tsx watch` in the first place) —
// `pnpm dev:daemon` already hot-reloads on ordinary source edits.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonPid, logPath, openLogFd, pingDaemon, waitFor } from "./daemon-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const pid = daemonPid();
  if (pid) {
    console.log(`Stopping current daemon (pid ${pid}) — this ends any live agent terminal sessions it's tracking.`);
    process.kill(pid, "SIGTERM");
    if (!(await waitFor(async () => daemonPid() === null, { timeoutMs: 10_000 }))) {
      console.error(`Daemon (pid ${pid}) did not stop in time.`);
      process.exit(1);
    }
  }

  console.log("Starting daemon...");
  const fd = openLogFd();
  // Via tsx (same as `pnpm dev:daemon`) — always current source, no
  // build+`node dist` step (see scripts/web.mjs for why).
  const child = spawn("pnpm", ["--filter", "daemon", "dev"], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();

  if (!(await waitFor(pingDaemon))) {
    console.error(`Daemon did not come up in time — check ${logPath}`);
    process.exit(1);
  }
  console.log(`Daemon reloaded (pid ${daemonPid()}), logging to ${logPath}`);
}

main();
