import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tcpTokenPath } from "./paths.js";

// Stable across restarts (persisted to disk) so a follower machine's
// BESIEGE_PRIMARY_TOKEN doesn't go stale every time this daemon restarts.
export function readOrCreateTcpToken(): string {
  if (existsSync(tcpTokenPath)) return readFileSync(tcpTokenPath, "utf8").trim();
  const token = randomBytes(32).toString("hex");
  writeFileSync(tcpTokenPath, token, { mode: 0o600 });
  return token;
}
