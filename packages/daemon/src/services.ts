// Shared services: a port on one fleet machine's loopback that other fleet
// machines reach on their own loopback. Definitions live in the control
// plane's DB (edited from the Fleet tab); every host learns what to do from
// the response to its heartbeat, so there is nothing to configure per host.
//
// The data path never touches the source machine's network interface: the
// exposing host listens on 127.0.0.1 and, per connection, opens a
// token-gated websocket to the source daemon's /tunnel/:port, which dials
// 127.0.0.1:port there. So a service that only binds loopback works, and
// the tailnet only ever carries daemon-to-daemon traffic.
import { connect, createServer, type Server, type Socket } from "node:net";
import type Database from "better-sqlite3";
import { WebSocket, createWebSocketStream } from "ws";
import { hostId as selfId } from "./host.js";
import { readOrCreateTcpToken } from "./tcp-token.js";

export interface ServiceDef {
  id: number;
  name: string;
  hostId: string;
  port: number;
  // null: every host other than the source.
  exposeOn: string[] | null;
  // null: the same as `port`.
  localPort: number | null;
  enabled: boolean;
  createdAt: string;
}

interface ServiceRow {
  id: number;
  name: string;
  host_id: string;
  port: number;
  expose_on: string | null;
  local_port: number | null;
  enabled: number;
  created_at: string;
}

function toDef(row: ServiceRow): ServiceDef {
  return {
    id: row.id,
    name: row.name,
    hostId: row.host_id,
    port: row.port,
    exposeOn: row.expose_on === null ? null : (JSON.parse(row.expose_on) as string[]),
    localPort: row.local_port,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export function listServices(db: Database.Database): ServiceDef[] {
  return (db.prepare("SELECT * FROM fleet_services ORDER BY id ASC").all() as ServiceRow[]).map(toDef);
}

export function getService(db: Database.Database, id: number): ServiceDef | null {
  const row = db.prepare("SELECT * FROM fleet_services WHERE id = ?").get(id) as ServiceRow | undefined;
  return row ? toDef(row) : null;
}

// How a service is addressed on the web port: /s/<slug>/. Derived from the
// name rather than asked for, and unique across services (see fleet routes).
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export interface ServiceInput {
  name: string;
  hostId: string;
  port: number;
  exposeOn: string[] | null;
  localPort: number | null;
  enabled: boolean;
}

const isPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;

// Validates a request body against the existing definition (for PATCH) or
// defaults (for POST). Returns the merged input, or the first problem.
export function parseServiceInput(body: unknown, current?: ServiceDef): ServiceInput | { error: string } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const name = raw.name === undefined ? current?.name : typeof raw.name === "string" ? raw.name.trim() : "";
  const host = raw.host_id === undefined ? current?.hostId : typeof raw.host_id === "string" ? raw.host_id.trim().toLowerCase() : "";
  const port = raw.port === undefined ? current?.port : raw.port;
  if (!name) return { error: "name is required" };
  if (!slugOf(name)) return { error: "name needs at least one letter or digit" };
  if (!host) return { error: "host_id is required" };
  if (!isPort(port)) return { error: "port must be an integer between 1 and 65535" };

  const localPort = raw.local_port === undefined ? (current?.localPort ?? null) : raw.local_port;
  if (localPort !== null && !isPort(localPort)) return { error: "local_port must be null or an integer between 1 and 65535" };

  let exposeOn = raw.expose_on === undefined ? (current?.exposeOn ?? null) : raw.expose_on;
  if (exposeOn !== null) {
    if (!Array.isArray(exposeOn) || exposeOn.some((h) => typeof h !== "string" || !h.trim())) {
      return { error: "expose_on must be null or a list of host ids" };
    }
    exposeOn = [...new Set((exposeOn as string[]).map((h) => h.trim().toLowerCase()))].filter((h) => h !== host);
    if ((exposeOn as string[]).length === 0) return { error: "expose_on must name at least one host other than the source" };
  }

  const enabled = raw.enabled === undefined ? (current?.enabled ?? true) : Boolean(raw.enabled);
  return { name, hostId: host, port, exposeOn: exposeOn as string[] | null, localPort, enabled };
}

export function createService(db: Database.Database, input: ServiceInput): ServiceDef {
  const info = db
    .prepare(
      "INSERT INTO fleet_services (name, host_id, port, expose_on, local_port, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.name,
      input.hostId,
      input.port,
      input.exposeOn === null ? null : JSON.stringify(input.exposeOn),
      input.localPort,
      input.enabled ? 1 : 0,
      new Date().toISOString(),
    );
  return getService(db, Number(info.lastInsertRowid))!;
}

export function updateService(db: Database.Database, id: number, input: ServiceInput): ServiceDef {
  db.prepare(
    "UPDATE fleet_services SET name = ?, host_id = ?, port = ?, expose_on = ?, local_port = ?, enabled = ? WHERE id = ?",
  ).run(
    input.name,
    input.hostId,
    input.port,
    input.exposeOn === null ? null : JSON.stringify(input.exposeOn),
    input.localPort,
    input.enabled ? 1 : 0,
    id,
  );
  return getService(db, id)!;
}

export function deleteService(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM fleet_services WHERE id = ?").run(id).changes > 0;
}

// ── What each host is told to do ──────────────────────────────────────────

export interface ExposeSpec {
  serviceId: number;
  name: string;
  sourceHost: string;
  // Where the source daemon's TCP listener is; null while it's unknown.
  sourceUrl: string | null;
  port: number;
  localPort: number;
}

export interface Assignments {
  // Loopback ports this host's daemon may dial for /tunnel/:port.
  serves: number[];
  // Loopback ports this host should listen on, and where each leads.
  expose: ExposeSpec[];
  // The same services as `serves`, by name, for /s/<slug>/ on this host.
  // Absent from an older control plane.
  named?: { name: string; port: number }[];
}

export const exposedLocalPort = (s: ServiceDef) => s.localPort ?? s.port;

export function exposesOn(service: ServiceDef, host: string): boolean {
  return service.enabled && service.hostId !== host && (service.exposeOn === null || service.exposeOn.includes(host));
}

export function assignmentsFor(
  db: Database.Database,
  host: string,
  urlOf: (hostId: string) => string | null,
): Assignments {
  const services = listServices(db).filter((s) => s.enabled);
  return {
    serves: services.filter((s) => s.hostId === host).map((s) => s.port),
    named: services.filter((s) => s.hostId === host).map((s) => ({ name: s.name, port: s.port })),
    expose: services
      .filter((s) => exposesOn(s, host))
      .map((s) => ({
        serviceId: s.id,
        name: s.name,
        sourceHost: s.hostId,
        sourceUrl: urlOf(s.hostId),
        port: s.port,
        localPort: exposedLocalPort(s),
      })),
  };
}

// ── This host: listeners and the tunnel endpoint ──────────────────────────

export type RelayState = "pending" | "listening" | "error";

export interface RelayStatus {
  serviceId: number;
  localPort: number;
  state: RelayState;
  // For "error", why it isn't listening; for "listening", the last reason a
  // connection through it failed (cleared by the next one that works).
  error: string | null;
}

interface Relay {
  spec: ExposeSpec;
  server: Server | null;
  sockets: Set<Socket>;
  state: RelayState;
  error: string | null;
  lastError: string | null;
}

const LOOPBACK = "127.0.0.1";

const relays = new Map<number, Relay>();
// Specs that lost their port to an earlier service in the same assignment.
const conflicts = new Map<number, RelayStatus>();
let served = new Set<number>();
let servedNamed: { name: string; port: number }[] = [];

// The same token every follower already holds for the control plane, which
// every daemon accepts on its TCP listener — the primary's own, or the one
// it was given as BESIEGE_PRIMARY_TOKEN.
function peerToken(): string {
  return process.env.BESIEGE_PRIMARY_TOKEN ?? readOrCreateTcpToken();
}

function describeFailure(err: Error): string {
  const m = err.message;
  if (m.includes("403")) return "source host isn't sharing this port";
  if (m.includes("401")) return "source host rejected the fleet token";
  return m;
}

function handleConnection(relay: Relay, socket: Socket): void {
  const { spec } = relay;
  relay.sockets.add(socket);
  socket.on("close", () => relay.sockets.delete(socket));
  socket.on("error", () => {});

  if (!spec.sourceUrl) {
    relay.lastError = `${spec.sourceHost} is not reachable`;
    socket.destroy();
    return;
  }

  const url = new URL(`/tunnel/${spec.port}`, spec.sourceUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${peerToken()}` } });
  const stream = createWebSocketStream(ws);

  ws.once("open", () => {
    relay.lastError = null;
  });
  // The source daemon closes with 1011 and the reason when the service
  // itself refuses the connection (e.g. nothing is listening on the port).
  ws.once("close", (code, reason) => {
    if (code === 1011) relay.lastError = `${spec.name}: ${reason.toString()}`;
  });
  stream.on("error", (err) => {
    relay.lastError = describeFailure(err);
    socket.destroy();
  });

  socket.pipe(stream);
  stream.pipe(socket);
  socket.on("close", () => stream.destroy());
  stream.on("close", () => socket.destroy());
}

function listen(relay: Relay, port: number): void {
  relay.state = "pending";
  relay.error = null;
  const server = createServer((socket) => handleConnection(relay, socket));
  relay.server = server;
  server.once("error", (err: NodeJS.ErrnoException) => {
    relay.state = "error";
    relay.error = err.code === "EADDRINUSE" ? `port ${port} is already in use on this machine` : err.message;
  });
  server.listen(port, LOOPBACK, () => {
    relay.state = "listening";
  });
}

function closeRelay(relay: Relay): void {
  relay.server?.close();
  for (const socket of relay.sockets) socket.destroy();
}

// Idempotent: called with the full desired state on every heartbeat, so a
// listener that failed to bind is retried on the next one.
export function applyAssignments(next: Assignments): void {
  served = new Set(next.serves);
  servedNamed = next.named ?? [];

  const wanted = new Map<number, ExposeSpec>();
  conflicts.clear();
  for (const spec of next.expose) {
    const holder = wanted.get(spec.localPort);
    if (holder) {
      conflicts.set(spec.serviceId, {
        serviceId: spec.serviceId,
        localPort: spec.localPort,
        state: "error",
        error: `port ${spec.localPort} is already used by ${holder.name}`,
      });
    } else {
      wanted.set(spec.localPort, spec);
    }
  }

  for (const [port, relay] of relays) {
    if (!wanted.has(port)) {
      closeRelay(relay);
      relays.delete(port);
    }
  }

  for (const [port, spec] of wanted) {
    const existing = relays.get(port);
    if (!existing) {
      const relay: Relay = { spec, server: null, sockets: new Set(), state: "pending", error: null, lastError: null };
      relays.set(port, relay);
      listen(relay, port);
      continue;
    }
    // Same port now leads somewhere else, or somewhere that moved: the
    // listener stays, new connections use the new spec.
    existing.spec = spec;
    if (existing.state === "error") listen(existing, port);
  }
}

export function relayStatuses(): RelayStatus[] {
  return [
    ...[...relays.values()].map((r) => ({
      serviceId: r.spec.serviceId,
      localPort: r.spec.localPort,
      state: r.state,
      error: r.state === "error" ? r.error : r.lastError,
    })),
    ...conflicts.values(),
  ];
}

export function closeRelays(): void {
  for (const relay of relays.values()) closeRelay(relay);
  relays.clear();
  conflicts.clear();
  served = new Set();
  servedNamed = [];
}

export interface LocalService {
  slug: string;
  name: string;
  // Loopback port on this machine that reaches it: the real service where
  // it runs, the relay's listener everywhere else.
  port: number;
  state: RelayState | "local";
}

// Every shared service this machine can reach on its own loopback, for the
// web server's /s/<slug>/ proxy. Own services win a name clash.
export function localServices(): LocalService[] {
  const own = servedNamed.map((s) => ({ slug: slugOf(s.name), name: s.name, port: s.port, state: "local" as const }));
  const relayed = [...relays.values()]
    .filter((r) => r.state !== "error")
    .map((r) => ({ slug: slugOf(r.spec.name), name: r.spec.name, port: r.spec.localPort, state: r.state }));
  return [...own, ...relayed];
}

export function isServed(port: number): boolean {
  return served.has(port);
}

// The source side of a relay: pipes one websocket to this machine's loopback.
export function openTunnel(ws: WebSocket, port: number): void {
  const target = connect({ host: LOOPBACK, port });
  const stream = createWebSocketStream(ws);
  target.on("error", (err) => {
    // Close reasons are limited to 123 bytes.
    if (ws.readyState === ws.OPEN) ws.close(1011, err.message.slice(0, 100));
    stream.destroy();
  });
  stream.on("error", () => target.destroy());
  target.pipe(stream);
  stream.pipe(target);
  target.on("close", () => stream.destroy());
  stream.on("close", () => target.destroy());
}

// ── Control plane: what other hosts say they're doing ─────────────────────

const reported = new Map<string, RelayStatus[]>();

export function recordRelayStatuses(host: string, statuses: RelayStatus[] | undefined): void {
  reported.set(host, statuses ?? []);
}

export function relayStatusesFor(host: string): RelayStatus[] {
  return host === selfId ? relayStatuses() : (reported.get(host) ?? []);
}
