// The control-plane half of a terminal session: the terminal_sessions row,
// where it runs, and keeping that row truthful. The PTY itself lives in
// pty-host.ts on whichever host the scheduler (fleet.ts) picked — this
// daemon, or another one reached over its /exec/* API.
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { choosePlacement, fleetToken, hostUrl, PlacementError, type Placement, type PlacementRequest } from "./fleet.js";
import type { Heartbeat } from "./heartbeat.js";
import { hostId as selfId } from "./host.js";
import { remapSessionIds, sessionIdsInTree, type PaneNode } from "./layout-tree.js";
import * as ptyHost from "./pty-host.js";
import { LaunchError, type LaunchSpec } from "./pty-host.js";
import { killRemote, launchRemote } from "./remote-exec.js";

// How long POST /terminals waits for placement before answering with a
// still-'placing' row. Covers every normal placement; only a wake outlasts it.
const SYNC_PLACEMENT_WAIT_MS = 3000;

// A placed session missing from its host's heartbeat is only presumed lost
// once it's older than this — the heartbeat may simply predate it.
const LOST_SESSION_GRACE_MS = 30_000;

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
  // Only set for adapters that can't pre-assign a conversation id (agy) —
  // see resolveResumeConversationId in pty-host.ts. NULL for every other
  // adapter; resume falls back to agent_session_id in that case.
  resume_session_id: string | null;
  // NULL means this daemon (rows from before fleets existed).
  host_id: string | null;
  exec_id: string | null;
  placement_status: "placing" | "placed" | "failed";
  placement_note: string | null;
  placed_at: string | null;
  peak_rss_bytes: number | null;
}

export function sessionHost(row: Pick<TerminalSessionRow, "host_id">): string {
  return row.host_id ?? selfId;
}

export interface SpawnRequest {
  campaignId: number;
  cwd: string;
  label?: string;
  agentAdapterName?: string;
  yolo?: boolean;
  extraArgs?: string;
  origin: string | null;
  host?: string;
  requires?: string[];
  // Continue this session's agent conversation. Pins placement to its host,
  // since that's where the agent CLI keeps the transcript.
  resumeFrom?: TerminalSessionRow;
}

export type SpawnResult = { ok: true; row: TerminalSessionRow } | { ok: false; status: number; error: string };

function getRow(db: Database.Database, id: number): TerminalSessionRow | undefined {
  return db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(id) as TerminalSessionRow | undefined;
}

function insertRow(db: Database.Database, req: SpawnRequest): number {
  const prior = req.resumeFrom;
  const info = db
    .prepare(
      `INSERT INTO terminal_sessions
         (campaign_id, label, cwd, status, created_at, agent_adapter_name, yolo, extra_args,
          agent_session_id, resume_session_id, placement_status)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 'placing')`,
    )
    .run(
      req.campaignId,
      req.label || req.agentAdapterName || null,
      req.cwd,
      new Date().toISOString(),
      req.agentAdapterName ?? null,
      req.yolo && req.agentAdapterName ? 1 : 0,
      req.agentAdapterName && req.extraArgs?.trim() ? req.extraArgs.trim() : null,
      // Persisted for every session, not only resumable ones, so
      // GET /terminal-sessions/by-agent-session/:id can resolve any
      // session's notifications/claims back to it. Reused on resume so
      // claims made before and after tie back to the same logical session.
      prior?.agent_session_id ?? randomUUID(),
      prior?.resume_session_id ?? null,
    );
  return Number(info.lastInsertRowid);
}

function specFor(row: TerminalSessionRow, placement: Placement, resume: boolean): LaunchSpec {
  return {
    campaignId: row.campaign_id,
    cwd: row.cwd,
    adapterName: row.agent_adapter_name ?? undefined,
    yolo: Boolean(row.yolo),
    extraArgs: row.extra_args ?? undefined,
    sessionId: row.agent_session_id!,
    resume: resume ? { resumeSessionId: row.resume_session_id } : undefined,
    env: placement.env,
    nice: placement.nice,
    owner: selfId,
  };
}

function markFailed(db: Database.Database, id: number, message: string): void {
  db.prepare(
    "UPDATE terminal_sessions SET status = 'exited', exited_at = ?, placement_status = 'failed', placement_note = ? WHERE id = ?",
  ).run(new Date().toISOString(), message, id);
}

function markExited(db: Database.Database, id: number, exitCode: number | null): void {
  db.prepare(
    "UPDATE terminal_sessions SET status = 'exited', exit_code = ?, exited_at = ? WHERE id = ? AND status = 'active'",
  ).run(exitCode, new Date().toISOString(), id);
}

function recordPlaced(db: Database.Database, id: number, placement: Placement, record: ptyHost.ExecRecord): boolean {
  // Guarded on still being 'placing' and active: the user may have closed
  // the pane while we were waking a host, and then nobody wants this PTY.
  const result = db
    .prepare(
      `UPDATE terminal_sessions
       SET host_id = ?, exec_id = ?, pid = ?, placement_status = 'placed', placed_at = ?, placement_note = ?
       WHERE id = ? AND status = 'active' AND placement_status = 'placing'`,
    )
    .run(placement.hostId, record.execId, record.pid, new Date().toISOString(), `${placement.hostId} (${placement.reason})`, id);
  return result.changes > 0;
}

async function placeAndLaunch(
  db: Database.Database,
  id: number,
  req: PlacementRequest,
  resume: boolean,
): Promise<SpawnResult> {
  const setNote = (message: string) =>
    db.prepare("UPDATE terminal_sessions SET placement_note = ? WHERE id = ?").run(message, id);
  let placement: Placement | undefined;
  try {
    placement = await choosePlacement(db, req, setNote);
    const row = getRow(db, id);
    if (!row || row.status !== "active") return { ok: false, status: 409, error: "session closed while placing" };
    setNote(`starting on ${placement.hostId}…`);
    const spec = specFor(row, placement, resume);
    const record =
      placement.hostId === selfId ? ptyHost.launch(spec) : await launchRemote(placement.url!, fleetToken(), spec);
    if (!recordPlaced(db, id, placement, record)) {
      if (placement.hostId === selfId) ptyHost.kill(record.execId);
      else void killRemote(placement.url!, fleetToken(), record.execId).catch(() => {});
      return { ok: false, status: 409, error: "session closed while placing" };
    }
    return { ok: true, row: getRow(db, id)! };
  } catch (err) {
    const message = (err as Error).message;
    markFailed(db, id, message);
    const status = err instanceof LaunchError ? 400 : err instanceof PlacementError ? 503 : 502;
    return { ok: false, status, error: message };
  } finally {
    placement?.settle();
  }
}

function placementRequest(req: SpawnRequest): PlacementRequest {
  return {
    adapterName: req.agentAdapterName ?? null,
    origin: req.origin,
    host: req.resumeFrom ? sessionHost(req.resumeFrom) : req.host,
    pinned: !!req.resumeFrom,
    requires: req.requires ?? [],
  };
}

// Answers within SYNC_PLACEMENT_WAIT_MS. A placement still running by then
// (waking a host) carries on in the background; the row stays 'placing' and
// the pane's stream shows progress until it lands.
export async function spawnSession(db: Database.Database, req: SpawnRequest): Promise<SpawnResult> {
  const id = insertRow(db, req);
  const placing = placeAndLaunch(db, id, placementRequest(req), !!req.resumeFrom);
  const settled = await Promise.race([
    placing,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SYNC_PLACEMENT_WAIT_MS)),
  ]);
  if (settled === null) return { ok: true, row: getRow(db, id)! };
  if (!settled.ok) {
    // Fast failures keep the old contract — an error response, no row —
    // so a bad request doesn't leave a dead pane behind.
    db.prepare("DELETE FROM terminal_sessions WHERE id = ?").run(id);
  }
  return settled;
}

// Spawns on this daemon synchronously. Only for boot-time resume, which has
// to finish before layouts are rewritten and has nowhere else to go anyway.
function resumeHereSync(db: Database.Database, prior: TerminalSessionRow): number | null {
  const id = insertRow(db, {
    campaignId: prior.campaign_id,
    cwd: prior.cwd,
    label: prior.label ?? undefined,
    agentAdapterName: prior.agent_adapter_name ?? undefined,
    yolo: Boolean(prior.yolo),
    extraArgs: prior.extra_args ?? undefined,
    origin: selfId,
    resumeFrom: prior,
  });
  const placement: Placement = { hostId: selfId, url: null, env: {}, reason: "resumed", settle: () => {} };
  try {
    const record = ptyHost.launch(specFor(getRow(db, id)!, placement, true));
    recordPlaced(db, id, placement, record);
    return id;
  } catch {
    // Binary missing, bad flag template, no resume support, etc.
    db.prepare("DELETE FROM terminal_sessions WHERE id = ?").run(id);
    return null;
  }
}

// Mirrors exits and discovered resume ids of PTYs on this host into rows.
// Exec ids are globally unique, so a PTY this daemon runs for a remote
// control plane simply matches no row here.
export function watchLocalExecs(db: Database.Database): void {
  ptyHost.onExecEvent((event) => {
    const row = db.prepare("SELECT id FROM terminal_sessions WHERE exec_id = ?").get(event.execId) as
      | { id: number }
      | undefined;
    if (!row) return;
    if (event.type === "exit") markExited(db, row.id, event.exitCode);
    else db.prepare("UPDATE terminal_sessions SET resume_session_id = ? WHERE id = ?").run(event.resumeSessionId, row.id);
  });
}

export async function killSession(db: Database.Database, row: TerminalSessionRow): Promise<void> {
  markExited(db, row.id, null);
  if (!row.exec_id) return;
  const host = sessionHost(row);
  if (host === selfId) {
    ptyHost.kill(row.exec_id);
    return;
  }
  const url = hostUrl(host);
  // If the host is unreachable the row is still ended; its next heartbeat
  // reaps the orphaned PTY (see reconcileHost).
  if (url) await killRemote(url, fleetToken(), row.exec_id).catch(() => {});
}

// Unlike killSession (which stops the process but keeps the row around so
// its scrollback stays reviewable), this permanently removes the tab — the
// only way an already-exited session ever leaves the list.
export function removeSession(db: Database.Database, id: number): boolean {
  const row = getRow(db, id);
  if (!row) return false;
  if (row.status === "active") void killSession(db, row);
  db.prepare("DELETE FROM terminal_sessions WHERE id = ?").run(id);
  return true;
}

export function killAllLiveSessions(db: Database.Database): void {
  ptyHost.killAll();
  // Remote sessions are untouched — they run on other hosts and outlive
  // this daemon. Only rows for PTYs that just died here are ended.
  db.prepare(
    "UPDATE terminal_sessions SET status = 'exited', exited_at = ? WHERE status = 'active' AND COALESCE(host_id, ?) = ?",
  ).run(new Date().toISOString(), selfId, selfId);
}

export function remapLayouts(db: Database.Database, idMap: Map<number, number | null>): void {
  if (idMap.size === 0) return;
  const layoutRows = db.prepare("SELECT id, layout_tree FROM terminal_layouts").all() as {
    id: number;
    layout_tree: string;
  }[];
  const updateTree = db.prepare("UPDATE terminal_layouts SET layout_tree = ? WHERE id = ?");
  for (const row of layoutRows) {
    const tree = JSON.parse(row.layout_tree) as PaneNode;
    if (!sessionIdsInTree(tree).some((id) => idMap.has(id))) continue;
    updateTree.run(JSON.stringify(remapSessionIds(tree, idMap)), row.id);
  }
}

// No PTY can survive a daemon restart (the IPty handle only ever lived in
// that process), so every row for *this* host still marked 'active' is
// stale by definition. A session on an adapter with resume support gets
// relaunched under the *same* agent_session_id, so the agent CLI's own
// conversation continues. Rows on other hosts are left alone — their PTYs
// are fine, and their hosts' heartbeats will say so.
// Returns old-id -> new-id (or null if not resumed) for layout rewriting.
export function resumeSessionsOnBoot(db: Database.Database): Map<number, number | null> {
  const staleRows = db
    .prepare("SELECT * FROM terminal_sessions WHERE status = 'active' AND COALESCE(host_id, ?) = ?")
    .all(selfId, selfId) as TerminalSessionRow[];

  const idMap = new Map<number, number | null>();
  for (const row of staleRows) {
    // A row that never got placed (daemon died mid-wake) has nothing to
    // resume; one with a conversation id does.
    const resumable = row.placement_status === "placed" && row.agent_adapter_name && row.agent_session_id;
    markExited(db, row.id, null);
    idMap.set(row.id, resumable ? resumeHereSync(db, row) : null);
  }
  return idMap;
}

async function resumeOnHost(db: Database.Database, prior: TerminalSessionRow): Promise<number | null> {
  const id = insertRow(db, {
    campaignId: prior.campaign_id,
    cwd: prior.cwd,
    label: prior.label ?? undefined,
    agentAdapterName: prior.agent_adapter_name ?? undefined,
    yolo: Boolean(prior.yolo),
    extraArgs: prior.extra_args ?? undefined,
    origin: null,
    resumeFrom: prior,
  });
  const result = await placeAndLaunch(
    db,
    id,
    { adapterName: prior.agent_adapter_name, origin: null, host: sessionHost(prior), pinned: true, requires: [] },
    true,
  );
  if (result.ok) return id;
  db.prepare("DELETE FROM terminal_sessions WHERE id = ?").run(id);
  return null;
}

// Brings rows for one host in line with the snapshot it just sent: exits it
// saw, PTYs it lost, resource peaks, and orphans nobody owns any more.
export async function reconcileHost(db: Database.Database, hb: Heartbeat, previousBootId: string | null): Promise<void> {
  const byExec = new Map(hb.execs.map((e) => [e.execId, e]));
  const rows = db
    .prepare(
      "SELECT * FROM terminal_sessions WHERE status = 'active' AND placement_status = 'placed' AND COALESCE(host_id, ?) = ?",
    )
    .all(selfId, hb.hostId) as TerminalSessionRow[];

  const updatePeak = db.prepare(
    "UPDATE terminal_sessions SET peak_rss_bytes = MAX(COALESCE(peak_rss_bytes, 0), ?) WHERE id = ?",
  );

  // Exits on this daemon's own PTYs are recorded synchronously by
  // watchLocalExecs; heartbeats only add the resource numbers.
  if (hb.hostId === selfId) {
    for (const row of rows) {
      const exec = row.exec_id ? byExec.get(row.exec_id) : undefined;
      if (exec?.rssBytes) updatePeak.run(exec.rssBytes, row.id);
    }
    return;
  }

  const restarted = previousBootId !== null && previousBootId !== hb.bootId;
  const died: TerminalSessionRow[] = [];
  const now = Date.now();

  for (const row of rows) {
    const exec = row.exec_id ? byExec.get(row.exec_id) : undefined;
    if (exec?.status === "active") {
      if (exec.rssBytes) updatePeak.run(exec.rssBytes, row.id);
      if (exec.resumeSessionId && exec.resumeSessionId !== row.resume_session_id) {
        db.prepare("UPDATE terminal_sessions SET resume_session_id = ? WHERE id = ?").run(exec.resumeSessionId, row.id);
      }
    } else if (exec) {
      markExited(db, row.id, exec.exitCode);
    } else if (restarted) {
      markExited(db, row.id, null);
      died.push(row);
    } else if (now - Date.parse(row.placed_at ?? row.created_at) > LOST_SESSION_GRACE_MS) {
      markExited(db, row.id, null);
    }
  }

  const url = hb.url;
  if (url) {
    const findByExec = db.prepare("SELECT status FROM terminal_sessions WHERE exec_id = ?");
    for (const exec of hb.execs) {
      if (exec.owner !== selfId || exec.status !== "active" || exec.ageMs < LOST_SESSION_GRACE_MS) continue;
      const row = findByExec.get(exec.execId) as { status: string } | undefined;
      if (!row || row.status === "exited") void killRemote(url, fleetToken(), exec.execId).catch(() => {});
    }
  }

  const resumable = died.filter((row) => row.agent_adapter_name && row.agent_session_id);
  if (resumable.length === 0 && died.length === 0) return;

  const idMap = new Map<number, number | null>();
  for (const row of died) idMap.set(row.id, null);
  for (const row of resumable) idMap.set(row.id, await resumeOnHost(db, row));
  remapLayouts(db, idMap);

  const resumedIds = [...idMap.values()].filter((v): v is number => v !== null);
  // Points at a resumed session when there is one, so the inbox's
  // jump-to-session lands somewhere alive.
  const subject = resumedIds.length > 0 ? getRow(db, resumedIds[0])! : died[0];
  db.prepare(
    "INSERT INTO notifications (session_id, cwd, message, kind, created_at) VALUES (?, ?, ?, 'fleet', ?)",
  ).run(
    subject.agent_session_id ?? `fleet:${hb.hostId}`,
    subject.cwd,
    `${hb.hostId} restarted and took ${died.length} session(s) with it — resumed ${resumedIds.length} on ${hb.hostId}.`,
    new Date().toISOString(),
  );
}

