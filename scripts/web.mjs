#!/usr/bin/env node
// `pnpm web` — one-shot convenience command: ensures a daemon is up (starting
// one from a fresh build only if none is running — an already-running
// daemon is left alone, since restarting it would kill any live agent
// terminal sessions it's tracking), builds the web UI, serves it, and prints
// the URL to open. For active development on the web UI itself, use
// `pnpm dev:webclient` + `pnpm dev:webserver` instead (rebuild on save).
import { execSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonPid, logPath, openLogFd, pingDaemon, waitFor } from "./daemon-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.BESIEGE_WEB_PORT ?? "4571";

function run(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: repoRoot });
}

async function ensureDaemon() {
  if (daemonPid()) {
    console.log("Daemon already running — leaving it as-is.");
    return;
  }
  console.log("No daemon running — starting one from current source...");
  const fd = openLogFd();
  // Runs via tsx (same as `pnpm dev:daemon`), not a build+`node dist` step:
  // always current source, and sidesteps a native better-sqlite3 crash seen
  // in this environment when running the compiled dist/index.js directly.
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
  console.log(`Daemon started (pid ${daemonPid()}), logging to ${logPath}`);
}

async function main() {
  await ensureDaemon();

  console.log("Building web UI...");
  run("pnpm --filter gui build:webclient");
  run("pnpm --filter gui build:webserver");

  console.log("Starting web server...");
  const server = spawn("node", ["packages/gui/out/web-server/index.js"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, BESIEGE_WEB_PORT: port },
  });
  server.on("exit", (code) => process.exit(code ?? 0));

  const url = `http://127.0.0.1:${port}`;
  const up = await waitFor(async () => {
    try {
      await fetch(url);
      return true;
    } catch {
      return false;
    }
  });
  if (!up) {
    console.error("Web server did not come up in time.");
    server.kill();
    process.exit(1);
  }
  console.log(`Web UI available at ${url}`);

  const shutdown = () => {
    server.kill("SIGTERM");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
