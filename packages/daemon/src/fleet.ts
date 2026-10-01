// Control-plane view of the fleet: the latest heartbeat from every host,
// and the scheduler that turns "a session wants to run" into "run it on
// host X". Hosts are only ever known by the ids they report; fleet.yaml
// decides what each id is allowed to do.
import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  explicitHostIds,
  fleetConfigPath,
  hostConfig,
  loadFleetConfig,
  type FleetConfig,
  type HostConfig,
} from "./fleet-config.js";
import { buildHeartbeat, type Heartbeat } from "./heartbeat.js";
import { hostId as selfId } from "./host.js";
import type { HostStats } from "./host-stats.js";
import { wakeRemote } from "./remote-exec.js";
import { readOrCreateTcpToken } from "./tcp-token.js";
import { performWake } from "./wake.js";

interface HostState {
  hostId: string;
  bootId: string;
  url: string | null;
  stats: HostStats;
  lastSeen: number;
}

const hosts = new Map<string, HostState>();

// Capacity a just-placed session will use but that the host's next
// heartbeat can't show yet — without this, a burst of spawns would all see
// the same pre-burst numbers and pile onto one host.
const RESERVATION_MS = 30_000;
const reservations = new Map<string, { memoryBytes: number; cpu: number; until: number }[]>();

// Placements chosen but not yet recorded on a row (the launch call is still
// in flight). Counted against last-resort slots so two concurrent spawns
// can't both take the last one.
const inFlight = new Map<string, number>();

const SHELL_COST = { memoryBytes: 256 * 1024 ** 2, cpu: 0.25 };
const COST_SAMPLE_SIZE = 20;
const COST_MIN_SAMPLES = 3;

export class PlacementError extends Error {}

export interface PlacementRequest {
  adapterName: string | null;
  // The host the request came from; null when it has no compute of its own
  // (a phone using the web UI served by the control plane).
  origin: string | null;
  // Forces a host. Skips the capacity check but still needs it online.
  host?: string;
  // Like host, but the session can't run anywhere else (its agent
  // transcript lives there), which changes the error a user sees.
  pinned?: boolean;
  requires: string[];
}

export interface Placement {
  hostId: string;
  url: string | null;
  env: Record<string, string>;
  nice?: number;
  reason: string;
  // Call once the placement is recorded on its row, or abandoned.
  settle(): void;
}

// The bearer token the control plane presents to other hosts' /exec/* API.
// Followers accept it because it's the same value they were configured
// with as BESIEGE_PRIMARY_TOKEN.
export function fleetToken(): string {
  return readOrCreateTcpToken();
}

export function hydrateHosts(db: Database.Database): void {
  const rows = db.prepare("SELECT * FROM fleet_hosts").all() as {
    host_id: string;
    boot_id: string;
    url: string | null;
    stats: string | null;
    last_seen_at: string;
  }[];
  for (const row of rows) {
    if (row.host_id === selfId || !row.stats) continue;
    hosts.set(row.host_id, {
      hostId: row.host_id,
      bootId: row.boot_id,
      url: row.url,
      stats: JSON.parse(row.stats) as HostStats,
      lastSeen: Date.parse(row.last_seen_at),
    });
  }
}

// Returns the boot id this host had before, so the caller can tell whether
// it restarted (and took its PTYs with it) since the last heartbeat.
export function recordHeartbeat(db: Database.Database, hb: Heartbeat): string | null {
  const stored = db.prepare("SELECT boot_id FROM fleet_hosts WHERE host_id = ?").get(hb.hostId) as
    | { boot_id: string }
    | undefined;
  const now = Date.now();
  hosts.set(hb.hostId, { hostId: hb.hostId, bootId: hb.bootId, url: hb.url, stats: hb.stats, lastSeen: now });
  db.prepare(
    `INSERT INTO fleet_hosts (host_id, boot_id, url, stats, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(host_id) DO UPDATE SET boot_id = excluded.boot_id, url = excluded.url,
       stats = excluded.stats, last_seen_at = excluded.last_seen_at`,
  ).run(hb.hostId, hb.bootId, hb.url, JSON.stringify(hb.stats), new Date(now).toISOString());
  return stored?.boot_id ?? null;
}

export function selfHeartbeat(db: Database.Database): Heartbeat {
  const hb = buildHeartbeat();
  recordHeartbeat(db, hb);
  return hb;
}

export function hostUrl(id: string): string | null {
  return hosts.get(id)?.url ?? null;
}

function isOnline(id: string, config: FleetConfig): boolean {
  if (id === selfId) return true;
  const state = hosts.get(id);
  return !!state?.url && Date.now() - state.lastSeen <= config.offlineAfterMs;
}

export function isHostOnline(id: string): boolean {
  return isOnline(id, loadFleetConfig());
}

function reserved(id: string): { memoryBytes: number; cpu: number } {
  const now = Date.now();
  const live = (reservations.get(id) ?? []).filter((r) => r.until > now);
  reservations.set(id, live);
  return {
    memoryBytes: live.reduce((sum, r) => sum + r.memoryBytes, 0),
    cpu: live.reduce((sum, r) => sum + r.cpu, 0),
  };
}

function reserve(id: string, cost: { memoryBytes: number; cpu: number }): void {
  reservations.set(id, [...(reservations.get(id) ?? []), { ...cost, until: Date.now() + RESERVATION_MS }]);
}

function statsFor(db: Database.Database, id: string): HostStats | null {
  if (id === selfId) return hosts.get(selfId)?.stats ?? selfHeartbeat(db).stats;
  return hosts.get(id)?.stats ?? null;
}

// Average peak RSS of this adapter's recent sessions, once there are enough
// of them to mean something; until then, the configured default.
function estimateCost(db: Database.Database, adapterName: string | null, config: FleetConfig) {
  const samples = db
    .prepare(
      "SELECT peak_rss_bytes AS peak FROM terminal_sessions WHERE agent_adapter_name IS ? AND peak_rss_bytes IS NOT NULL ORDER BY id DESC LIMIT ?",
    )
    .all(adapterName, COST_SAMPLE_SIZE) as { peak: number }[];
  const fallback = adapterName ? config.defaultCost : SHELL_COST;
  if (samples.length < COST_MIN_SAMPLES) return fallback;
  return {
    memoryBytes: samples.reduce((sum, s) => sum + s.peak, 0) / samples.length,
    cpu: fallback.cpu,
  };
}

function fit(
  db: Database.Database,
  id: string,
  cost: { memoryBytes: number; cpu: number },
  config: FleetConfig,
): { ok: boolean; headroom: number; summary: string } {
  const stats = statsFor(db, id);
  if (!stats) return { ok: false, headroom: -Infinity, summary: "no stats" };
  const r = reserved(id);
  const memFrac = (stats.memTotalBytes - stats.memAvailableBytes + r.memoryBytes + cost.memoryBytes) / stats.memTotalBytes;
  const cpuFrac = (stats.load1 + r.cpu + cost.cpu) / stats.cpus;
  const headroom = Math.min(config.limits.memory - memFrac, config.limits.cpu - cpuFrac);
  const summary = `mem ${Math.round(memFrac * 100)}%, cpu ${Math.round(cpuFrac * 100)}% with this session`;
  return { ok: headroom >= 0, headroom, summary };
}

function activeCount(db: Database.Database, id: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM terminal_sessions WHERE status = 'active' AND placement_status = 'placed' AND COALESCE(host_id, ?) = ?",
    )
    .get(selfId, id) as { n: number };
  return row.n;
}

function hasTags(hc: HostConfig, requires: string[]): boolean {
  return requires.every((tag) => hc.tags.includes(tag));
}

// Every host the scheduler could consider, in a stable order: the ones
// named in fleet.yaml first (so its order is a tie-breaker), then any
// others that have heartbeated.
function knownHostIds(config: FleetConfig): string[] {
  return [...new Set([...explicitHostIds(config), selfId, ...hosts.keys()])];
}

function placementOn(id: string, hc: HostConfig, reason: string, lastResort: boolean): Placement {
  inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
  let settled = false;
  return {
    settle: () => {
      if (settled) return;
      settled = true;
      inFlight.set(id, (inFlight.get(id) ?? 1) - 1);
    },
    hostId: id,
    url: id === selfId ? null : hostUrl(id),
    env: { ...hc.env, ...(lastResort ? hc.lastResort?.env : {}) },
    nice: (lastResort ? hc.lastResort?.nice : undefined) ?? hc.nice,
    reason,
  };
}

async function wake(id: string, hc: HostConfig, config: FleetConfig): Promise<boolean> {
  if (hc.wake.method === "none") return false;
  const via = hc.wake.via ?? selfId;
  if (!isOnline(via, config)) return false;
  try {
    if (via === selfId) await performWake(hc.wake);
    else await wakeRemote(hostUrl(via)!, fleetToken(), hc.wake);
    return true;
  } catch (err) {
    console.error(`waking ${id} via ${via} failed: ${(err as Error).message}`);
    return false;
  }
}

export async function choosePlacement(
  db: Database.Database,
  req: PlacementRequest,
  note: (message: string) => void,
): Promise<Placement> {
  const config = loadFleetConfig();

  // A lone daemon with no fleet.yaml and nobody heartbeating to it keeps
  // the pre-fleet behavior: always run here, whatever the load.
  const remoteKnown = [...hosts.keys()].some((id) => id !== selfId);
  if (!existsSync(fleetConfigPath) && !remoteKnown && (!req.host || req.host === selfId)) {
    return placementOn(selfId, hostConfig(config, selfId), "local", false);
  }

  if (req.host) {
    const id = req.host.toLowerCase();
    if (!isOnline(id, config)) {
      throw new PlacementError(
        req.pinned
          ? `this session's agent transcript lives on ${id}, which is offline — bring it back to resume`
          : `host ${id} is offline`,
      );
    }
    const hc = hostConfig(config, id);
    return placementOn(id, hc, req.pinned ? "resumed" : "requested", !hc.pool && !!hc.lastResort);
  }

  const cost = estimateCost(db, req.adapterName, config);
  const tried: string[] = [];

  for (const step of config.order) {
    if (step === "origin") {
      const id = req.origin;
      if (!id) continue;
      const hc = hostConfig(config, id);
      if (!hc.pool || !hasTags(hc, req.requires) || !isOnline(id, config)) continue;
      const f = fit(db, id, cost, config);
      if (f.ok) {
        reserve(id, cost);
        return placementOn(id, hc, "origin", false);
      }
      tried.push(`${id} (${f.summary})`);
    }

    if (step === "pool") {
      const candidates = knownHostIds(config)
        .filter((id) => id !== req.origin)
        .map((id) => ({ id, hc: hostConfig(config, id) }))
        .filter(({ id, hc }) => hc.pool && hasTags(hc, req.requires) && isOnline(id, config))
        .map((c) => ({ ...c, fit: fit(db, c.id, cost, config) }));
      for (const c of candidates) if (!c.fit.ok) tried.push(`${c.id} (${c.fit.summary})`);
      const best = candidates.filter((c) => c.fit.ok).sort((a, b) => b.fit.headroom - a.fit.headroom)[0];
      if (best) {
        reserve(best.id, cost);
        return placementOn(best.id, best.hc, "pool", false);
      }
    }

    if (step === "wake") {
      const sleeping = knownHostIds(config)
        .map((id) => ({ id, hc: hostConfig(config, id) }))
        .filter(({ id, hc }) => hc.pool && hc.wake.method !== "none" && hasTags(hc, req.requires) && !isOnline(id, config));
      if (sleeping.length === 0) continue;
      note(`waking ${sleeping.map((c) => c.id).join(", ")}…`);
      const woken = (await Promise.all(sleeping.map(async (c) => ((await wake(c.id, c.hc, config)) ? c : null)))).filter(
        (c): c is (typeof sleeping)[number] => c !== null,
      );
      if (woken.length === 0) {
        tried.push(...sleeping.map((c) => `${c.id} (wake failed)`));
        continue;
      }
      const deadline = Date.now() + config.wakeTimeoutMs;
      while (Date.now() < deadline) {
        for (const c of woken) {
          if (!isOnline(c.id, config)) continue;
          if (fit(db, c.id, cost, config).ok) {
            reserve(c.id, cost);
            return placementOn(c.id, c.hc, "woken", false);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      tried.push(...woken.map((c) => `${c.id} (didn't wake within ${Math.round(config.wakeTimeoutMs / 1000)}s)`));
    }

    if (step === "last_resort") {
      for (const id of knownHostIds(config)) {
        const hc = hostConfig(config, id);
        if (!hc.lastResort || !hasTags(hc, req.requires) || !isOnline(id, config)) continue;
        const used = activeCount(db, id) + (inFlight.get(id) ?? 0);
        if (used >= hc.lastResort.slots) {
          tried.push(`${id} (last-resort slots full: ${used}/${hc.lastResort.slots})`);
          continue;
        }
        reserve(id, cost);
        return placementOn(id, hc, "last resort", true);
      }
    }
  }

  throw new PlacementError(
    tried.length > 0 ? `no host can take this session — ${[...new Set(tried)].join("; ")}` : "no host can take this session",
  );
}

export interface HostView {
  hostId: string;
  self: boolean;
  status: "online" | "recovering" | "offline";
  url: string | null;
  lastSeenAt: string | null;
  stats: HostStats | null;
  activeSessions: number;
  pool: boolean;
  tags: string[];
  wake: string;
  lastResortSlots: number | null;
}

export function listHosts(db: Database.Database): HostView[] {
  const config = loadFleetConfig();
  return knownHostIds(config).map((id) => {
    const hc = hostConfig(config, id);
    const state = hosts.get(id) ?? null;
    const since = state ? Date.now() - state.lastSeen : Infinity;
    const status = isOnline(id, config) ? "online" : since <= hc.restartGraceMs ? "recovering" : "offline";
    return {
      hostId: id,
      self: id === selfId,
      status,
      url: state?.url ?? null,
      lastSeenAt: state ? new Date(state.lastSeen).toISOString() : null,
      stats: state?.stats ?? null,
      activeSessions: activeCount(db, id),
      pool: hc.pool,
      tags: hc.tags,
      wake: hc.wake.method,
      lastResortSlots: hc.lastResort?.slots ?? null,
    };
  });
}
