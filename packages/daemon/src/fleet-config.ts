// fleet.yaml: the single hand-edited file (kept on the control plane only)
// that describes which hosts may run sessions and how to wake them. Nothing
// in the code knows any machine by name — a host that heartbeats but isn't
// listed just gets `defaults`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { parse } from "yaml";
import { stateDir } from "./paths.js";

export const fleetConfigPath = process.env.BESIEGE_FLEET_CONFIG ?? join(stateDir, "fleet.yaml");

export type PlacementStep = "origin" | "pool" | "wake" | "last_resort";

export type WakeConfig =
  | { method: "none" }
  | { method: "wol"; via?: string; macAddress: string; broadcast?: string }
  | { method: "command"; via?: string; run: string };

export interface LastResortConfig {
  slots: number;
  env: Record<string, string>;
  nice?: number;
}

export interface HostConfig {
  pool: boolean;
  tags: string[];
  env: Record<string, string>;
  nice?: number;
  wake: WakeConfig;
  restartGraceMs: number;
  lastResort?: LastResortConfig;
}

export interface FleetConfig {
  order: PlacementStep[];
  limits: { memory: number; cpu: number };
  defaultCost: { memoryBytes: number; cpu: number };
  wakeTimeoutMs: number;
  offlineAfterMs: number;
  defaults: HostConfig;
  // Insertion order matters: exact keys win, then the first matching glob.
  hosts: [pattern: string, config: Partial<HostConfig>][];
}

const STEPS: PlacementStep[] = ["origin", "pool", "wake", "last_resort"];

const BUILTIN_DEFAULTS: HostConfig = {
  pool: true,
  tags: [],
  env: {},
  wake: { method: "none" },
  restartGraceMs: 2 * 60_000,
};

const EMPTY_CONFIG: FleetConfig = {
  order: STEPS,
  limits: { memory: 0.8, cpu: 0.8 },
  defaultCost: { memoryBytes: 4 * 1024 ** 3, cpu: 1 },
  wakeTimeoutMs: 90_000,
  offlineAfterMs: 15_000,
  defaults: BUILTIN_DEFAULTS,
  hosts: [],
};

export function parseDuration(value: unknown, fallback: number): number {
  if (typeof value === "number") return value * 1000;
  if (typeof value !== "string") return fallback;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!match) throw new Error(`invalid duration: ${value}`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? "s"]!;
  return Number(match[1]) * unit;
}

export function parseSize(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return fallback;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)?$/i);
  if (!match) throw new Error(`invalid size: ${value}`);
  const units: Record<string, number> = {
    b: 1,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
  };
  return Number(match[1]) * units[(match[2] ?? "b").toLowerCase()]!;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be a mapping`);
  return value as Record<string, unknown>;
}

function asEnv(value: unknown, where: string): Record<string, string> {
  return Object.fromEntries(Object.entries(asRecord(value, where)).map(([k, v]) => [k, String(v)]));
}

function parseWake(value: unknown, where: string): WakeConfig {
  if (value === undefined || value === null || value === "none") return { method: "none" };
  const raw = asRecord(value, where);
  const via = raw.via === undefined ? undefined : String(raw.via).toLowerCase();
  switch (raw.method) {
    case "none":
      return { method: "none" };
    case "wol":
      if (typeof raw.mac_address !== "string") throw new Error(`${where}.mac_address is required for wol`);
      return {
        method: "wol",
        via,
        macAddress: raw.mac_address,
        broadcast: typeof raw.broadcast === "string" ? raw.broadcast : undefined,
      };
    case "command":
      if (typeof raw.run !== "string") throw new Error(`${where}.run is required for command`);
      return { method: "command", via, run: raw.run };
    default:
      throw new Error(`${where}.method must be one of none, wol, command`);
  }
}

function parseHost(value: unknown, where: string): Partial<HostConfig> {
  const raw = asRecord(value, where);
  const host: Partial<HostConfig> = {};
  if (raw.pool !== undefined) host.pool = Boolean(raw.pool);
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) throw new Error(`${where}.tags must be a list`);
    host.tags = raw.tags.map(String);
  }
  if (raw.env !== undefined) host.env = asEnv(raw.env, `${where}.env`);
  if (raw.nice !== undefined) host.nice = Number(raw.nice);
  if (raw.wake !== undefined) host.wake = parseWake(raw.wake, `${where}.wake`);
  if (raw.restart_grace !== undefined) host.restartGraceMs = parseDuration(raw.restart_grace, 0);
  if (raw.last_resort !== undefined) {
    const lr = asRecord(raw.last_resort, `${where}.last_resort`);
    host.lastResort = {
      slots: lr.slots === undefined ? 1 : Number(lr.slots),
      env: asEnv(lr.env, `${where}.last_resort.env`),
      nice: lr.nice === undefined ? undefined : Number(lr.nice),
    };
  }
  return host;
}

export function parseFleetConfig(source: string): FleetConfig {
  const raw = asRecord(parse(source), "fleet.yaml");
  const placement = asRecord(raw.placement, "placement");
  const limits = asRecord(placement.limits, "placement.limits");
  const cost = asRecord(placement.default_cost, "placement.default_cost");

  let order = EMPTY_CONFIG.order;
  if (placement.order !== undefined) {
    if (!Array.isArray(placement.order)) throw new Error("placement.order must be a list");
    for (const step of placement.order) {
      if (!STEPS.includes(step as PlacementStep)) throw new Error(`unknown placement step: ${step}`);
    }
    order = placement.order as PlacementStep[];
  }

  const hosts = Object.entries(asRecord(raw.hosts, "hosts")).map(
    ([pattern, value]) => [pattern.toLowerCase(), parseHost(value, `hosts.${pattern}`)] as [string, Partial<HostConfig>],
  );

  return {
    order,
    limits: {
      memory: limits.memory === undefined ? EMPTY_CONFIG.limits.memory : Number(limits.memory),
      cpu: limits.cpu === undefined ? EMPTY_CONFIG.limits.cpu : Number(limits.cpu),
    },
    defaultCost: {
      memoryBytes: parseSize(cost.memory, EMPTY_CONFIG.defaultCost.memoryBytes),
      cpu: cost.cpu === undefined ? EMPTY_CONFIG.defaultCost.cpu : Number(cost.cpu),
    },
    wakeTimeoutMs: parseDuration(placement.wake_timeout, EMPTY_CONFIG.wakeTimeoutMs),
    offlineAfterMs: parseDuration(placement.offline_after, EMPTY_CONFIG.offlineAfterMs),
    defaults: { ...BUILTIN_DEFAULTS, ...parseHost(raw.defaults, "defaults") },
    hosts,
  };
}

let cached: { mtimeMs: number; config: FleetConfig } | null = null;
let lastError: string | null = null;

// Re-read whenever the file's mtime changes, so edits apply to the next
// placement without a restart. A broken edit keeps the last good config
// instead of silently dropping back to "no fleet".
export function loadFleetConfig(): FleetConfig {
  if (!existsSync(fleetConfigPath)) {
    cached = null;
    lastError = null;
    return EMPTY_CONFIG;
  }
  const { mtimeMs } = statSync(fleetConfigPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.config;
  try {
    const config = parseFleetConfig(readFileSync(fleetConfigPath, "utf8"));
    cached = { mtimeMs, config };
    lastError = null;
    return config;
  } catch (err) {
    lastError = (err as Error).message;
    console.error(`fleet.yaml rejected, keeping previous config: ${lastError}`);
    if (cached) cached.mtimeMs = mtimeMs;
    return cached?.config ?? EMPTY_CONFIG;
  }
}

export function fleetConfigError(): string | null {
  return lastError;
}

export function hostConfig(config: FleetConfig, id: string): HostConfig {
  const exact = config.hosts.find(([pattern]) => pattern === id);
  const match = exact ?? config.hosts.find(([pattern]) => minimatch(id, pattern));
  return { ...config.defaults, ...(match?.[1] ?? {}) };
}

// Hosts named literally in the file — the only ones the scheduler can try
// to wake before it has ever heard from them.
export function explicitHostIds(config: FleetConfig): string[] {
  return config.hosts.map(([pattern]) => pattern).filter((p) => !/[*?[\]{}!]/.test(p));
}
