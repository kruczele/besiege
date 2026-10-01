// The execution half of a terminal session: owns PTYs on *this* machine,
// keyed by an opaque execId, and knows nothing about campaigns, layouts or
// the database. Whichever daemon is the control plane (this one, or a
// remote primary over /exec/*) records what each exec belongs to.
import * as pty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import type { WebSocket } from "ws";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAgentConfig, type AgentConfig } from "./agent-config.js";
import { stripInheritedAgentEnv } from "./env.js";
import { stateDir } from "./paths.js";

// Ring buffer cap: last ~200KB of output per session. A chatty long-lived
// session (tail -f, a build loop) must not grow the daemon's memory forever.
const RING_BUFFER_MAX_BYTES = 200_000;

// How long an exited exec stays reportable, so a control plane that missed
// the exit (network blip, its own restart) still learns the exit code from
// the next heartbeat instead of having to guess.
const EXITED_RETENTION_MS = 60 * 60_000;

// Shared across every session — the besiege MCP server is a single stdio
// process description (not session-specific), so one config file on disk is
// enough; agents just point at it via their own --mcp-config-style flag.
const MCP_CONFIG_PATH = join(stateDir, "mcp-config.json");

// This module runs as either dist/pty-host.js (prod) or src/pty-host.ts
// (dev, under tsx watch) — import.meta.url differs between the two, so it is
// NOT a stable anchor for the mcp entry point. Going one directory up from
// wherever this file happens to live always lands on the daemon package
// root, from which dist/mcp.js — the one built, runnable entry point,
// regardless of which mode the daemon itself is running under — is stable.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_ENTRY_POINT = join(PACKAGE_ROOT, "dist", "mcp.js");

export interface LaunchSpec {
  campaignId: number;
  cwd: string;
  adapterName?: string;
  yolo?: boolean;
  extraArgs?: string;
  // Minted by the control plane. Always exported as BESIEGE_SESSION_ID, and
  // also handed to the adapter's sessionIdFlag when it can pre-assign its
  // own conversation id (Claude), so the two are the same value.
  sessionId: string;
  // Present when continuing sessionId's conversation instead of starting a
  // fresh one. resumeSessionId is only set for adapters that can't
  // pre-assign an id (agy) — see resolveResumeConversationId.
  resume?: { resumeSessionId?: string | null };
  env?: Record<string, string>;
  nice?: number;
  // Host id of the control plane that asked for this exec. Lets that
  // control plane reap orphans from a heartbeat without touching execs some
  // other control plane (e.g. this host's own DB, while it was offline) owns.
  owner: string;
}

// A launch the spec itself makes impossible on this host (unknown adapter,
// no resume support) — as opposed to an unexpected failure.
export class LaunchError extends Error {}

export interface ExecRecord {
  execId: string;
  owner: string;
  pid: number;
  startedAt: number;
  status: "active" | "exited";
  exitCode: number | null;
  exitedAt: number | null;
  resumeSessionId: string | null;
}

export type ExecEvent =
  | { type: "exit"; execId: string; exitCode: number | null }
  | { type: "resume-id"; execId: string; resumeSessionId: string };

interface LiveExec {
  record: ExecRecord;
  pty: IPty;
  buffer: string;
  subscribers: Set<WebSocket>;
}

const live = new Map<string, LiveExec>();
const exited = new Map<string, ExecRecord>();
const listeners = new Set<(event: ExecEvent) => void>();

export function onExecEvent(listener: (event: ExecEvent) => void): void {
  listeners.add(listener);
}

function emit(event: ExecEvent): void {
  for (const listener of listeners) listener(event);
}

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

// For CLIs where MCP is a persistent named registry rather than a
// per-launch flag (agy's `agy mcp add <name> <cmd> [args]`, "add or
// update") — run the adapter's registration command once before spawn.
// Same "regenerate every call, never trust a prior run" rationale as
// ensureMcpConfig; fails open (a broken/missing binary here must not block
// the session itself from starting, it just starts without Besiege's MCP
// tools).
function ensureMcpRegistered(adapter: AgentConfig): void {
  if (!adapter.mcpRegisterCommand) return;
  try {
    const argv = splitArgs(adapter.mcpRegisterCommand).map((token) =>
      token.replace("{execPath}", process.execPath).replace("{mcpEntryPoint}", MCP_ENTRY_POINT),
    );
    execFileSync(adapter.binary, argv, { timeout: 5000, stdio: "ignore" });
  } catch {
    // Binary missing, registry unreachable, etc — spawn proceeds without it.
  }
}

// Best-effort read of a workspace-keyed session-cache file (agy's
// last_conversations.json: absolute cwd -> conversation id). Missing file /
// malformed JSON / wrong shape all resolve to "no entry" rather than
// throwing — this is undocumented third-party state, never trusted to be
// well-formed.
function readWorkspaceCacheEntry(path: string, cwd: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(expandHome(path), "utf8"));
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>)[cwd];
      if (typeof value === "string") return value;
    }
  } catch {
    // no file yet, bad JSON, etc.
  }
  return undefined;
}

// For adapters with sessionIdFromWorkspaceCache set (agy): the CLI mints
// its own conversation id and only surfaces it, undocumented, via a
// workspace-path-keyed cache file it writes shortly after an interactive
// session starts in that cwd. Poll for a *change* from whatever was there
// before spawn (not just presence — a stale entry from an earlier, unrelated
// session in the same dir would otherwise be misattributed to this one) and
// report it once found. Give up silently after a timeout, and bail early if
// the session has already exited — this is strictly best-effort, resume just
// isn't offered if it never lands.
function discoverWorkspaceCacheSessionId(
  execId: string,
  cachePath: string,
  cwd: string,
  previousValue: string | undefined,
): void {
  const deadline = Date.now() + 20_000;
  const poll = () => {
    const session = live.get(execId);
    if (!session) return; // session already exited
    const current = readWorkspaceCacheEntry(cachePath, cwd);
    if (current && current !== previousValue) {
      session.record.resumeSessionId = current;
      emit({ type: "resume-id", execId, resumeSessionId: current });
      return;
    }
    if (Date.now() < deadline) setTimeout(poll, 1000);
  };
  setTimeout(poll, 1000);
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
export function expandHome(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return join(homedir(), cwd.slice(2));
  return cwd;
}

// Which conversation id to feed the adapter's resumeFlag / to gate resume
// availability on. Adapters that mint their own id and only surface it
// post-launch (sessionIdFromWorkspaceCache set — agy) must use
// resumeSessionId specifically: sessionId there is Besiege's own
// correlation id (BESIEGE_SESSION_ID), not a real conversation id, and
// passing it to e.g. `--conversation` would resume nothing that exists.
// Every other adapter falls back to sessionId.
export function resolveResumeConversationId(
  adapter: AgentConfig | undefined,
  sessionId: string | null,
  resumeSessionId: string | null | undefined,
): string | null {
  if (adapter?.sessionIdFromWorkspaceCache) return resumeSessionId ?? null;
  return resumeSessionId ?? sessionId;
}

function appendToBuffer(session: LiveExec, chunk: string): void {
  session.buffer += chunk;
  if (session.buffer.length > RING_BUFFER_MAX_BYTES) {
    session.buffer = session.buffer.slice(session.buffer.length - RING_BUFFER_MAX_BYTES);
  }
}

function broadcast(session: LiveExec, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const ws of session.subscribers) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function retire(session: LiveExec, exitCode: number | null): void {
  live.delete(session.record.execId);
  session.record.status = "exited";
  session.record.exitCode = exitCode;
  session.record.exitedAt = Date.now();
  exited.set(session.record.execId, session.record);
  broadcast(session, { type: "exit", exitCode });
  emit({ type: "exit", execId: session.record.execId, exitCode });
}

function pruneExited(): void {
  const cutoff = Date.now() - EXITED_RETENTION_MS;
  for (const [execId, record] of exited) {
    if ((record.exitedAt ?? 0) < cutoff) exited.delete(execId);
  }
}

export function launch(spec: LaunchSpec): ExecRecord {
  const cwd = expandHome(spec.cwd);

  const adapter = spec.adapterName ? findAgentConfig(spec.adapterName) : undefined;
  if (spec.adapterName && !adapter) throw new LaunchError(`agent adapter not found: ${spec.adapterName}`);

  let resumeConversationId: string | null = null;
  if (spec.resume) {
    if (!adapter?.resumeFlag) throw new LaunchError("adapter does not support resume");
    resumeConversationId = resolveResumeConversationId(adapter, spec.sessionId, spec.resume.resumeSessionId);
    if (!resumeConversationId) throw new LaunchError("session has no resumable agent conversation");
  }

  if (adapter) ensureMcpRegistered(adapter);

  // Snapshotted before spawn so the post-launch poll below can tell a fresh
  // entry apart from a stale one already sitting in the cache file for this
  // cwd from an earlier, unrelated session.
  const workspaceCacheEntryBefore =
    !spec.resume && adapter?.sessionIdFromWorkspaceCache
      ? readWorkspaceCacheEntry(adapter.sessionIdFromWorkspaceCache, cwd)
      : undefined;

  const binary = adapter?.binary ?? "zsh";
  const mcpArgs = adapter?.mcpConfigFlag
    ? splitArgs(adapter.mcpConfigFlag).map((token) => token.replace("{path}", ensureMcpConfig()))
    : [];

  const sessionArgs =
    resumeConversationId && adapter?.resumeFlag
      ? splitArgs(adapter.resumeFlag).map((token) => token.replace("{sessionId}", resumeConversationId))
      : adapter?.sessionIdFlag
        ? splitArgs(adapter.sessionIdFlag).map((token) => token.replace("{sessionId}", spec.sessionId))
        : [];

  const argv = adapter
    ? [
        ...mcpArgs,
        ...sessionArgs,
        ...(spec.yolo && adapter.yoloFlag ? [adapter.yoloFlag] : []),
        ...(spec.extraArgs ? splitArgs(spec.extraArgs) : []),
      ]
    : [];

  const [command, args] =
    spec.nice !== undefined ? ["nice", ["-n", String(spec.nice), binary, ...argv]] : [binary, argv];

  // Lets MCP tool calls from inside this session self-identify without the
  // agent needing to pass a campaign id on every call — mirrors the
  // BESIEGE_* env vars `besiege dispatch` already sets (cli.ts).
  const proc = pty.spawn(command, args, {
    cols: 80,
    rows: 24,
    cwd,
    env: {
      ...stripInheritedAgentEnv(process.env),
      ...spec.env,
      BESIEGE_CAMPAIGN_ID: String(spec.campaignId),
      BESIEGE_SESSION_ID: spec.sessionId,
    },
  });

  pruneExited();
  const record: ExecRecord = {
    execId: randomUUID(),
    owner: spec.owner,
    pid: proc.pid,
    startedAt: Date.now(),
    status: "active",
    exitCode: null,
    exitedAt: null,
    resumeSessionId: spec.resume?.resumeSessionId ?? null,
  };
  const session: LiveExec = { record, pty: proc, buffer: "", subscribers: new Set() };
  live.set(record.execId, session);

  if (!spec.resume && adapter?.sessionIdFromWorkspaceCache) {
    discoverWorkspaceCacheSessionId(record.execId, adapter.sessionIdFromWorkspaceCache, cwd, workspaceCacheEntryBefore);
  }

  proc.onData((chunk) => {
    appendToBuffer(session, chunk);
    broadcast(session, { type: "output", data: chunk });
  });

  proc.onExit(({ exitCode }) => {
    // An explicit kill already retired this exec synchronously, since it
    // can't wait for this async event to land before the daemon shuts down.
    if (live.get(record.execId) !== session) return;
    retire(session, exitCode);
  });

  return { ...record };
}

export function attach(execId: string, ws: WebSocket): boolean {
  const session = live.get(execId);
  if (!session) return false;
  if (session.buffer) ws.send(JSON.stringify({ type: "output", data: session.buffer }));
  session.subscribers.add(ws);
  ws.on("close", () => session.subscribers.delete(ws));
  return true;
}

export function write(execId: string, data: string): boolean {
  const session = live.get(execId);
  if (!session) return false;
  session.pty.write(data);
  return true;
}

export function resize(execId: string, cols: number, rows: number): boolean {
  const session = live.get(execId);
  if (!session) return false;
  session.pty.resize(cols, rows);
  return true;
}

export function kill(execId: string): boolean {
  const session = live.get(execId);
  if (!session) return false;
  retire(session, null);
  session.pty.kill();
  return true;
}

export function killAll(): void {
  for (const session of [...live.values()]) {
    retire(session, null);
    session.pty.kill();
  }
}

export function isLive(execId: string): boolean {
  return live.has(execId);
}

// Live and recently exited execs, for heartbeats.
export function listExecs(): ExecRecord[] {
  pruneExited();
  return [...[...live.values()].map((s) => s.record), ...exited.values()].map((r) => ({ ...r }));
}
