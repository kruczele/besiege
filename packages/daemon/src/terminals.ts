import * as pty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import type Database from "better-sqlite3";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAgentConfig } from "./agent-config.js";
import { stripInheritedAgentEnv } from "./env.js";
import { stateDir } from "./paths.js";

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
  agent_adapter_name: string | null;
  yolo: number;
  extra_args: string | null;
  agent_session_id: string | null;
}

// Shared across every session — the besiege MCP server is a single stdio
// process description (not session-specific), so one config file on disk is
// enough; agents just point at it via their own --mcp-config-style flag.
const MCP_CONFIG_PATH = join(stateDir, "mcp-config.json");

// This module runs as either dist/terminals.js (prod) or src/terminals.ts
// (dev, under tsx watch) — import.meta.url differs between the two, so it is
// NOT a stable anchor for the mcp entry point. Going one directory up from
// wherever this file happens to live always lands on the daemon package
// root, from which dist/mcp.js — the one built, runnable entry point,
// regardless of which mode the daemon itself is running under — is stable.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_ENTRY_POINT = join(PACKAGE_ROOT, "dist", "mcp.js");

// Regenerated on every call rather than left in place once written: a stale
// file from a wrong dev/prod mode or a moved install would otherwise wire
// every future agent session to a command that no longer exists, silently.
function ensureMcpConfig(): string {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    MCP_CONFIG_PATH,
    JSON.stringify(
      {
        mcpServers: {
          besiege: { command: process.execPath, args: [MCP_ENTRY_POINT] },
        },
      },
      null,
      2,
    ),
  );
  return MCP_CONFIG_PATH;
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

// A cwd typed by hand (campaign default_dir, terminal cwd override) commonly
// starts with "~" the way a shell prompt would accept — but pty.spawn's cwd
// option is a raw chdir(), no shell in between to expand it, so a literal
// "~/..." silently fails to chdir and the process exits immediately.
function expandHome(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return join(homedir(), cwd.slice(2));
  return cwd;
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
  agentAdapterName?: string,
  yolo?: boolean,
  extraArgs?: string,
  // Set only by resumeSessionsOnBoot, continuing a prior agent conversation
  // by id instead of minting a fresh one.
  resumeAgentSessionId?: string,
): TerminalSessionRow {
  cwd = expandHome(cwd);

  const adapter = agentAdapterName ? findAgentConfig(agentAdapterName) : undefined;

  const command = adapter?.binary ?? "zsh";
  const mcpArgs = adapter?.mcpConfigFlag
    ? splitArgs(adapter.mcpConfigFlag).map((token) => token.replace("{path}", ensureMcpConfig()))
    : [];

  // A fresh session on an adapter that supports resume gets a pinned id up
  // front, so a later daemon restart has something to pass to resume_flag;
  // a boot-time resume instead reuses the id it's continuing.
  const agentSessionId = resumeAgentSessionId ?? (adapter?.sessionIdFlag ? randomUUID() : null);
  const sessionArgs =
    resumeAgentSessionId && adapter?.resumeFlag
      ? splitArgs(adapter.resumeFlag).map((token) => token.replace("{sessionId}", resumeAgentSessionId))
      : agentSessionId && adapter?.sessionIdFlag
        ? splitArgs(adapter.sessionIdFlag).map((token) => token.replace("{sessionId}", agentSessionId))
        : [];

  const argv = adapter
    ? [
        ...mcpArgs,
        ...sessionArgs,
        ...(yolo && adapter.yoloFlag ? [adapter.yoloFlag] : []),
        ...(extraArgs ? splitArgs(extraArgs) : []),
      ]
    : [];

  // Lets MCP tool calls from inside this session self-identify without the
  // agent needing to pass a campaign id on every call — mirrors the
  // BESIEGE_* env vars `besiege dispatch` already sets (cli.ts). Reuses the
  // adapter's own resumable conversation id when there is one, so claims
  // and notifications made before *and* after a boot-time resume tie back
  // to the same logical session.
  const besiegeSessionId = agentSessionId ?? randomUUID();
  const proc = pty.spawn(command, argv, {
    cols: 80,
    rows: 24,
    cwd,
    env: {
      ...stripInheritedAgentEnv(process.env),
      BESIEGE_CAMPAIGN_ID: String(campaignId),
      BESIEGE_SESSION_ID: besiegeSessionId,
    },
  });

  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      "INSERT INTO terminal_sessions (campaign_id, label, cwd, pid, status, created_at, agent_adapter_name, yolo, extra_args, agent_session_id) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
    )
    .run(
      campaignId,
      label ?? adapter?.name ?? null,
      cwd,
      proc.pid,
      createdAt,
      adapter?.name ?? null,
      yolo && adapter ? 1 : 0,
      adapter && extraArgs?.trim() ? extraArgs.trim() : null,
      agentSessionId,
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

// No PTY can survive a daemon restart (the IPty handle only ever lived in
// this process's `live` map), so every row still marked 'active' from a
// previous process is stale by definition. Unlike the old reap-only
// behavior, a session on an adapter with resume support gets relaunched
// under a new pid but the *same* agent_session_id, so the agent CLI's own
// conversation continues (assuming that CLI persists its transcript by
// session id — Besiege's part is just passing the right resume flag).
// Returns old-id -> new-id (or null if not resumed) so the caller can
// rewrite layout trees to point at the resumed sessions.
export function resumeSessionsOnBoot(db: Database.Database): Map<number, number | null> {
  const staleRows = db
    .prepare("SELECT * FROM terminal_sessions WHERE status = 'active'")
    .all() as TerminalSessionRow[];

  const idMap = new Map<number, number | null>();
  const now = new Date().toISOString();

  for (const row of staleRows) {
    let resumedId: number | null = null;
    const adapter = row.agent_adapter_name ? findAgentConfig(row.agent_adapter_name) : undefined;
    if (adapter?.resumeFlag && row.agent_session_id) {
      try {
        const resumed = spawnSession(
          db,
          row.campaign_id,
          row.cwd,
          row.label ?? undefined,
          row.agent_adapter_name ?? undefined,
          Boolean(row.yolo),
          row.extra_args ?? undefined,
          row.agent_session_id,
        );
        resumedId = resumed.id;
      } catch {
        // Binary missing, bad flag template, etc — fall through and treat
        // this session like any other unresumable one below.
        resumedId = null;
      }
    }
    idMap.set(row.id, resumedId);
    db.prepare("UPDATE terminal_sessions SET status = 'exited', exited_at = ? WHERE id = ?").run(now, row.id);
  }

  return idMap;
}
