// A heartbeat is a full snapshot of this host — stats plus every exec it
// knows about — rather than a stream of events, so a control plane that
// missed anything (its own restart, a dropped request) is fully caught up
// by the next one.
import { bootId, hostId } from "./host.js";
import { hostStats, processTreeUsage, type HostStats } from "./host-stats.js";
import { listExecs, type ExecRecord } from "./pty-host.js";

export const HEARTBEAT_INTERVAL_MS = 5000;

export interface HeartbeatExec extends ExecRecord {
  // Relative to the sender's own clock, so the receiver needn't trust
  // clocks being in sync.
  ageMs: number;
  rssBytes: number | null;
  cpuPercent: number | null;
}

export interface Heartbeat {
  hostId: string;
  bootId: string;
  // Where the control plane reaches this host's /exec/* API. Null when the
  // host has no reachable TCP listener, which keeps it out of placement.
  url: string | null;
  stats: HostStats;
  execs: HeartbeatExec[];
}

export function advertisedUrl(): string | null {
  if (process.env.BESIEGE_ADVERTISE_URL) return process.env.BESIEGE_ADVERTISE_URL;
  const port = process.env.BESIEGE_TCP_PORT;
  const host = process.env.BESIEGE_TCP_HOST;
  if (!port || !host || host === "127.0.0.1" || host === "localhost") return null;
  return `http://${host}:${port}`;
}

export function buildHeartbeat(): Heartbeat {
  const execs = listExecs();
  const usage = processTreeUsage(execs.filter((e) => e.status === "active").map((e) => e.pid));
  const now = Date.now();
  return {
    hostId,
    bootId,
    url: advertisedUrl(),
    stats: hostStats(),
    execs: execs.map((e) => ({
      ...e,
      ageMs: now - e.startedAt,
      rssBytes: usage.get(e.pid)?.rssBytes ?? null,
      cpuPercent: usage.get(e.pid)?.cpuPercent ?? null,
    })),
  };
}

async function send(primaryUrl: string, token: string | undefined, timeoutMs: number): Promise<void> {
  await fetch(new URL("/fleet/heartbeat", primaryUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(buildHeartbeat()),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// Runs on every daemon configured with BESIEGE_PRIMARY_URL. Failures are
// expected (primary rebooting, laptop offline) and simply retried next tick.
export function startHeartbeatLoop(primaryUrl: string, token: string | undefined): {
  // Sent on clean shutdown after every PTY is killed, so the control plane
  // records those sessions as deliberately ended rather than lost to a
  // crash (which it would auto-resume).
  sendFinal(): Promise<void>;
  stop(): void;
} {
  if (!advertisedUrl()) {
    console.warn(
      "BESIEGE_PRIMARY_URL is set but this host advertises no reachable URL (set BESIEGE_TCP_HOST/BESIEGE_TCP_PORT " +
        "or BESIEGE_ADVERTISE_URL) — the control plane will see it but never place sessions on it",
    );
  }
  const tick = () => void send(primaryUrl, token, 4000).catch(() => {});
  tick();
  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  return {
    sendFinal: () => send(primaryUrl, token, 1500).catch(() => {}),
    stop: () => clearInterval(timer),
  };
}
