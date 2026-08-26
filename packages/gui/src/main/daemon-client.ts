import { request } from "node:http";
import { socketPath } from "./daemon-paths.js";

export interface DaemonHealth {
  status: string;
  pid: number;
  uptimeSeconds: number;
  db: { startupCount: number; lastStartedAt?: string };
}

export function fetchDaemonHealth(): Promise<DaemonHealth> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: "/health", method: "GET", timeout: 2000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`daemon responded with ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as DaemonHealth);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("daemon request timed out")));
    req.on("error", reject);
    req.end();
  });
}
