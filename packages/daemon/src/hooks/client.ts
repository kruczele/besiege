import { request } from "node:http";
import { socketPath } from "../paths.js";

function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
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
            reject(new Error(`daemon responded with ${res.statusCode}`));
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

export const getJson = <T>(path: string) => call<T>("GET", path);
export const postJson = <T>(path: string, body: unknown) => call<T>("POST", path, body);

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}
