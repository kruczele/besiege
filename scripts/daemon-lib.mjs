// Shared by scripts/web.mjs and scripts/reload-daemon.mjs.
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

// Mirrors packages/daemon/src/paths.ts — must stay in sync.
const override = process.env.BESIEGE_STATE_DIR;
const xdgStateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
export const stateDir = override ?? join(xdgStateHome, "besiege");
export const socketPath = join(stateDir, "daemon.sock");
export const pidPath = join(stateDir, "daemon.pid");
export const logPath = join(stateDir, "daemon.log");

// Returns the daemon's pid if a live process is holding it, else null —
// mirrors the daemon's own acquireSingleInstanceLock() staleness check.
export function daemonPid() {
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function pingDaemon() {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: "/health", method: "GET", timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function waitFor(checkFn, { timeoutMs = 15_000, intervalMs = 200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkFn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Opens (creating stateDir if needed) an append fd for a detached daemon
// child's stdout/stderr, so its output is inspectable instead of lost.
export function openLogFd() {
  mkdirSync(stateDir, { recursive: true });
  return openSync(logPath, "a");
}
