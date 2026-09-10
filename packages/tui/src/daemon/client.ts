// Talks to the daemon's Unix socket directly, the same way
// packages/gui/src/main/daemon-client.ts does from Electron's main process —
// the TUI is a plain Node process too, so there's no IPC/sandbox boundary to
// route through. Socket path resolution is duplicated from
// packages/daemon/src/paths.ts (a few lines, low duplication risk) rather
// than imported, since daemon's package.json doesn't expose that module.
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const override = process.env.BESIEGE_STATE_DIR;
const xdgStateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
const stateDir = override ?? join(xdgStateHome, "besiege");
export const socketPath = join(stateDir, "daemon.sock");

export function callDaemon<T>(
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method,
        timeout: 2000,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 300) {
            reject(new Error(`daemon responded with ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(data ? (JSON.parse(data) as T) : (undefined as T));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("daemon request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}
