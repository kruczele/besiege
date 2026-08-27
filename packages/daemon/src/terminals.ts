import * as pty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import type Database from "better-sqlite3";
import type { WebSocket } from "ws";

// Ring buffer cap: last ~200KB of output per session. A chatty long-lived
// session (tail -f, a build loop) must not grow the daemon's memory forever.
const RING_BUFFER_MAX_BYTES = 200_000;

export interface TerminalSessionRow {
  id: number;
  campaign_id: number;
  label: string | null;
  cwd: string;
  pid: number | null;
  status: "active" | "exited";
  exit_code: number | null;
  created_at: string;
  exited_at: string | null;
  agent_adapter_id: number | null;
  yolo: number;
  extra_args: string | null;
}

interface AgentAdapterRow {
  id: number;
  name: string;
  binary: string;
  yolo_flag: string | null;
  created_at: string;
}

// Quoted-segment aware tokenizer for the free-text "extra args" field, so
// e.g. --append-system-prompt "some text" stays a single argv entry instead
// of being split on the space inside the quotes.
function splitArgs(input: string): string[] {
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const args: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

interface LiveSession {
  id: number;
  pty: IPty;
  buffer: string;
  subscribers: Set<WebSocket>;
}

const live = new Map<number, LiveSession>();

function appendToBuffer(session: LiveSession, chunk: string): void {
  session.buffer += chunk;
  if (session.buffer.length > RING_BUFFER_MAX_BYTES) {
    session.buffer = session.buffer.slice(session.buffer.length - RING_BUFFER_MAX_BYTES);
  }
}

function broadcast(session: LiveSession, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const ws of session.subscribers) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

export function spawnSession(
  db: Database.Database,
  campaignId: number,
  cwd: string,
  label?: string,
  agentAdapterId?: number,
  yolo?: boolean,
  extraArgs?: string,
): TerminalSessionRow {
  const adapter = agentAdapterId
    ? (db.prepare("SELECT * FROM agent_adapters WHERE id = ?").get(agentAdapterId) as
        | AgentAdapterRow
        | undefined)
    : undefined;

  const command = adapter?.binary ?? "zsh";
  const argv = adapter
    ? [...(yolo && adapter.yolo_flag ? [adapter.yolo_flag] : []), ...(extraArgs ? splitArgs(extraArgs) : [])]
    : [];

  const proc = pty.spawn(command, argv, { cols: 80, rows: 24, cwd, env: process.env });

  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      "INSERT INTO terminal_sessions (campaign_id, label, cwd, pid, status, created_at, agent_adapter_id, yolo, extra_args) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)",
    )
    .run(
      campaignId,
      label ?? adapter?.name ?? null,
      cwd,
      proc.pid,
      createdAt,
      adapter?.id ?? null,
      yolo && adapter ? 1 : 0,
      adapter && extraArgs?.trim() ? extraArgs.trim() : null,
    );
  const id = Number(info.lastInsertRowid);

  const session: LiveSession = { id, pty: proc, buffer: "", subscribers: new Set() };
  live.set(id, session);

  proc.onData((chunk) => {
    appendToBuffer(session, chunk);
    broadcast(session, { type: "output", data: chunk });
  });

  proc.onExit(({ exitCode }) => {
    // Guard against double-handling: an explicit kill (killSession /
    // killAllLiveSessions) already deletes the map entry and writes the db
    // row synchronously, since it can't wait for this async event to land
    // before the daemon shuts down and closes the db.
    if (!live.has(id)) return;
    db.prepare(
      "UPDATE terminal_sessions SET status = 'exited', exit_code = ?, exited_at = ? WHERE id = ?",
    ).run(exitCode, new Date().toISOString(), id);
    broadcast(session, { type: "exit", exitCode });
    live.delete(id);
  });

  return db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(id) as TerminalSessionRow;
}

export function attachSubscriber(id: number, ws: WebSocket): boolean {
  const session = live.get(id);
  if (!session) return false;
  if (session.buffer) ws.send(JSON.stringify({ type: "output", data: session.buffer }));
  session.subscribers.add(ws);
  ws.on("close", () => session.subscribers.delete(ws));
  return true;
}

export function writeToSession(id: number, data: string): boolean {
  const session = live.get(id);
  if (!session) return false;
  session.pty.write(data);
  return true;
}

export function resizeSession(id: number, cols: number, rows: number): boolean {
  const session = live.get(id);
  if (!session) return false;
  session.pty.resize(cols, rows);
  return true;
}

export function killSession(db: Database.Database, id: number): boolean {
  const session = live.get(id);
  if (!session) return false;
  live.delete(id);
  db.prepare(
    "UPDATE terminal_sessions SET status = 'exited', exited_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
  broadcast(session, { type: "exit", exitCode: null });
  session.pty.kill();
  return true;
}

// Unlike killSession (which stops the process but keeps the row around so
// its scrollback stays reviewable), this permanently removes the tab — the
// only way an already-exited session ever leaves the list.
export function removeSession(db: Database.Database, id: number): boolean {
  const session = live.get(id);
  if (session) {
    live.delete(id);
    session.pty.kill();
  }
  const result = db.prepare("DELETE FROM terminal_sessions WHERE id = ?").run(id);
  return result.changes > 0;
}

export function killAllLiveSessions(db: Database.Database): void {
  for (const [id, session] of [...live]) {
    live.delete(id);
    db.prepare(
      "UPDATE terminal_sessions SET status = 'exited', exited_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), id);
    session.pty.kill();
  }
}

export function reapStaleSessionsOnBoot(db: Database.Database): void {
  db.prepare(
    "UPDATE terminal_sessions SET status = 'exited', exited_at = ? WHERE status = 'active'",
  ).run(new Date().toISOString());
}
