import { request } from "node:http";
import { socketPath } from "../paths.js";

function call<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method,
        timeout: timeoutMs,
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

export const getJson = <T>(path: string, timeoutMs?: number) => call<T>("GET", path, undefined, timeoutMs);
export const postJson = <T>(path: string, body: unknown, timeoutMs?: number) => call<T>("POST", path, body, timeoutMs);
export const patchJson = <T>(path: string, body: unknown, timeoutMs?: number) => call<T>("PATCH", path, body, timeoutMs);
export const deleteJson = <T>(path: string, timeoutMs?: number) => call<T>("DELETE", path, undefined, timeoutMs);

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}
