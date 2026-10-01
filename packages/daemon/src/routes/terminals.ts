import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { WebSocket } from "ws";
import { fleetToken, hostUrl } from "../fleet.js";
import { ORIGIN_HOST_HEADER, hostId as selfId } from "../host.js";
import * as ptyHost from "../pty-host.js";
import { openRemoteStream } from "../remote-exec.js";
import {
  killSession,
  removeSession,
  sessionHost,
  spawnSession,
  type SpawnResult,
  type TerminalSessionRow,
} from "../terminals.js";
import { pruneSessionFromLayouts } from "./layouts.js";

const PLACING_POLL_MS = 500;
const PLACING_MAX_WAIT_MS = 5 * 60_000;

interface CampaignRow {
  id: number;
  default_dir: string | null;
}

const SELECT_SESSION = "SELECT * FROM terminal_sessions ts";

const toSession = (r: TerminalSessionRow) => ({
  id: r.id,
  campaignId: r.campaign_id,
  label: r.label,
  cwd: r.cwd,
  pid: r.pid,
  status: r.status,
  exitCode: r.exit_code,
  createdAt: r.created_at,
  exitedAt: r.exited_at,
  agentAdapterName: r.agent_adapter_name,
  yolo: Boolean(r.yolo),
  extraArgs: r.extra_args,
  agentSessionId: r.agent_session_id,
  hostId: sessionHost(r),
  execId: r.exec_id,
  placementStatus: r.placement_status,
  placementNote: r.placement_note,
  // False for a daemon with no fleet (every placement is "local"), so
  // clients can skip host labels that would only ever say the same thing.
  fleetPlaced: r.placement_note !== null && !r.placement_note.endsWith("(local)"),
});

const dim = (text: string) => `\x1b[90m${text}\x1b[0m\r\n`;

// Input/resize frames from a viewer, applied to a PTY on this host. Shared
// with the /exec stream (routes/exec.ts), which is the same thing addressed
// by exec id.
export function handleViewerMessages(socket: WebSocket, execId: string): void {
  socket.on("message", (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
    const m = msg as { type: string; data?: string; cols?: number; rows?: number };
    if (m.type === "input" && typeof m.data === "string") {
      ptyHost.write(execId, m.data);
    } else if (m.type === "resize" && typeof m.cols === "number" && typeof m.rows === "number") {
      ptyHost.resize(execId, m.cols, m.rows);
    }
  });
}

function proxyToHost(db: Database.Database, row: TerminalSessionRow, socket: WebSocket): void {
  const host = sessionHost(row);
  const url = hostUrl(host);
  if (!url || !row.exec_id) {
    socket.send(JSON.stringify({ type: "output", data: dim(`[besiege: ${host} is unreachable]`) }));
    socket.close();
    return;
  }
  const upstream = openRemoteStream(url, fleetToken(), row.exec_id);
  const pending: string[] = [];
  upstream.on("open", () => {
    for (const msg of pending.splice(0)) upstream.send(msg);
  });
  // Always re-sent as a string: `ws` hands "message" a Buffer even for
  // text frames, and re-sending that Buffer would flip the frame to binary.
  upstream.on("message", (data) => {
    const text = data.toString();
    // Record the exit now rather than on the host's next heartbeat.
    if (text.startsWith('{"type":"exit"')) {
      const { exitCode } = JSON.parse(text) as { exitCode: number | null };
      db.prepare(
        "UPDATE terminal_sessions SET status = 'exited', exit_code = ?, exited_at = ? WHERE id = ? AND status = 'active'",
      ).run(exitCode, new Date().toISOString(), row.id);
    }
    if (socket.readyState === socket.OPEN) socket.send(text);
  });
  upstream.on("close", () => socket.close());
  upstream.on("error", () => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "output", data: dim(`[besiege: lost connection to ${host}]`) }));
    }
    socket.close();
  });
  socket.on("message", (data) => {
    const text = data.toString();
    if (upstream.readyState === upstream.OPEN) upstream.send(text);
    else if (upstream.readyState === upstream.CONNECTING) pending.push(text);
  });
  socket.on("close", () => upstream.close());
}

async function streamSession(db: Database.Database, id: number, socket: WebSocket): Promise<void> {
  const get = () =>
    db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(id) as TerminalSessionRow | undefined;
  let row = get();

  // Anything the viewer sends before the PTY is attached (its first resize,
  // keystrokes typed while a host wakes) is replayed once it is.
  const early: string[] = [];
  const collect = (data: unknown) => early.push(String(data));
  socket.on("message", collect);
  const replay = () => {
    socket.off("message", collect);
    for (const msg of early) socket.emit("message", Buffer.from(msg));
  };

  // A session still being placed (typically: waiting on a woken host)
  // shows its progress in the pane instead of an error.
  if (row?.placement_status === "placing") {
    let shownNote: string | null = null;
    const deadline = Date.now() + PLACING_MAX_WAIT_MS;
    socket.send(JSON.stringify({ type: "output", data: dim("[besiege: finding a host for this session…]") }));
    while (row?.placement_status === "placing" && socket.readyState === socket.OPEN && Date.now() < deadline) {
      if (row.placement_note && row.placement_note !== shownNote) {
        shownNote = row.placement_note;
        socket.send(JSON.stringify({ type: "output", data: dim(`[besiege: ${shownNote}]`) }));
      }
      await new Promise((resolve) => setTimeout(resolve, PLACING_POLL_MS));
      row = get();
    }
    if (socket.readyState !== socket.OPEN) return;
  }

  if (row?.placement_status === "failed") {
    socket.send(
      JSON.stringify({ type: "output", data: `\x1b[31m[besiege: couldn't start — ${row.placement_note}]\x1b[0m\r\n` }),
    );
    socket.send(JSON.stringify({ type: "exit", exitCode: null }));
    socket.close();
    return;
  }

  if (!row || row.status !== "active" || !row.exec_id) {
    socket.send(JSON.stringify({ type: "error", message: "session not active" }));
    socket.close();
    return;
  }

  if (sessionHost(row) !== selfId) {
    proxyToHost(db, row, socket);
    replay();
    return;
  }

  if (!ptyHost.attach(row.exec_id, socket)) {
    socket.send(JSON.stringify({ type: "error", message: "session not active" }));
    socket.close();
    return;
  }
  handleViewerMessages(socket, row.exec_id);
  replay();
}

function sendSpawnResult(
  db: Database.Database,
  result: SpawnResult,
  reply: { code(status: number): unknown },
) {
  if (!result.ok) {
    reply.code(result.status);
    return { error: result.error };
  }
  reply.code(201);
  return toSession(result.row);
}

export function registerTerminalRoutes(app: FastifyInstance, db: Database.Database) {
  // Global (not campaign-scoped) lookup — a notification only carries the
  // BESIEGE_SESSION_ID string of whoever raised it, not a campaign id, and
  // that id is the agent's own conversation id (agent_session_id) for any
  // adapter with resume support (Claude today). Used by the Inbox/Live
  // panels to resolve "which session/campaign is this about" so they can
  // show something more useful than a raw id and offer a jump-to-it button.
  app.get<{ Params: { agentSessionId: string } }>(
    "/terminal-sessions/by-agent-session/:agentSessionId",
    async (req, reply) => {
      const row = db
        .prepare(`${SELECT_SESSION} WHERE ts.agent_session_id = ? ORDER BY ts.id DESC LIMIT 1`)
        .get(req.params.agentSessionId) as TerminalSessionRow | undefined;
      if (!row) {
        reply.code(404);
        return { error: "not found" };
      }
      return toSession(row);
    },
  );

  // Hit by hooks/session-start.ts (using its own BESIEGE_SESSION_ID env var,
  // inherited from the pty it's a child process of) the moment its hook
  // actually runs inside a live Claude Code session — proof positive that
  // Besiege's hooks are wired up on this machine. hook-health.ts's periodic
  // sweep uses the absence of this to detect the opposite. Best-effort: a
  // session already gone (e.g. exited before the hook fired) is a no-op,
  // not an error, and the hook script ignores this route's response either way.
  app.post<{ Params: { agentSessionId: string } }>(
    "/terminal-sessions/by-agent-session/:agentSessionId/hook-confirm",
    async (req, reply) => {
      const result = db
        .prepare("UPDATE terminal_sessions SET hook_confirmed_at = ? WHERE agent_session_id = ?")
        .run(new Date().toISOString(), req.params.agentSessionId);
      if (result.changes === 0) {
        reply.code(404);
        return { error: "not found" };
      }
      reply.code(204);
    },
  );

  app.get<{ Params: { campaignId: string } }>(
    "/campaigns/:campaignId/terminals",
    async (req, reply) => {
      const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
      if (!campaign) {
        reply.code(404);
        return { error: "campaign not found" };
      }
      const rows = db
        .prepare(`${SELECT_SESSION} WHERE ts.campaign_id = ? ORDER BY ts.id DESC`)
        .all(req.params.campaignId) as TerminalSessionRow[];
      return rows.map(toSession);
    },
  );

  app.post<{
    Params: { campaignId: string };
    Body: {
      cwd?: string;
      label?: string;
      agentAdapterName?: string;
      yolo?: boolean;
      extraArgs?: string;
      // Manual counterpart to the boot-time auto-resume (terminals.ts
      // resumeSessionsOnBoot): relaunches the same agent conversation from
      // an exited session's own agent_session_id, e.g. a "Resume" button
      // on a pane whose agent process ended. Every other field on the body
      // is ignored in favor of what's recorded on that prior session.
      resumeFromTerminalId?: number;
      // Run on this host regardless of load (still has to be online).
      host?: string;
      // Tags (fleet.yaml) the chosen host must have.
      requires?: string[];
    };
  }>("/campaigns/:campaignId/terminals", async (req, reply) => {
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.campaignId) as
      | CampaignRow
      | undefined;
    if (!campaign) {
      reply.code(404);
      return { error: "campaign not found" };
    }

    const origin = (req.headers[ORIGIN_HOST_HEADER] as string | undefined)?.toLowerCase() ?? selfId;

    if (req.body?.resumeFromTerminalId !== undefined) {
      const prior = db
        .prepare("SELECT * FROM terminal_sessions WHERE id = ? AND campaign_id = ?")
        .get(req.body.resumeFromTerminalId, req.params.campaignId) as TerminalSessionRow | undefined;
      if (!prior) {
        reply.code(404);
        return { error: "session to resume from not found" };
      }
      if (!prior.agent_adapter_name || !prior.agent_session_id) {
        reply.code(400);
        return { error: "session has no resumable agent conversation" };
      }
      // Whether the adapter can resume is checked by the host that runs it,
      // against its own agents config.
      const result = await spawnSession(db, {
        campaignId: Number(req.params.campaignId),
        cwd: prior.cwd,
        label: prior.label ?? undefined,
        agentAdapterName: prior.agent_adapter_name,
        yolo: Boolean(prior.yolo),
        extraArgs: prior.extra_args ?? undefined,
        origin,
        resumeFrom: prior,
      });
      return sendSpawnResult(db, result, reply);
    }

    const cwd = req.body?.cwd?.trim() || campaign.default_dir;
    if (!cwd) {
      reply.code(400);
      return { error: "campaign has no default_dir; pass cwd explicitly" };
    }

    // The adapter is validated by whichever host the session lands on, since
    // agents.local.yaml is per machine.
    const result = await spawnSession(db, {
      campaignId: Number(req.params.campaignId),
      cwd,
      label: req.body?.label?.trim(),
      agentAdapterName: req.body?.agentAdapterName,
      yolo: req.body?.yolo,
      extraArgs: req.body?.extraArgs,
      origin,
      host: req.body?.host,
      requires: req.body?.requires,
    });
    return sendSpawnResult(db, result, reply);
  });

  app.get<{ Params: { id: string } }>("/terminals/:id", async (req, reply) => {
    const row = db.prepare(`${SELECT_SESSION} WHERE ts.id = ?`).get(req.params.id) as
      | TerminalSessionRow
      | undefined;
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    return toSession(row);
  });

  app.post<{ Params: { id: string } }>("/terminals/:id/kill", async (req, reply) => {
    const row = db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(req.params.id) as
      | TerminalSessionRow
      | undefined;
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    if (row.status === "active") await killSession(db, row);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/terminals/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const existing = db.prepare("SELECT campaign_id FROM terminal_sessions WHERE id = ?").get(id) as
      | { campaign_id: number }
      | undefined;
    const removed = removeSession(db, id);
    if (!removed) {
      reply.code(404);
      return { error: "not found" };
    }
    if (existing) pruneSessionFromLayouts(db, existing.campaign_id, id);
    reply.code(204);
  });

  app.get<{ Params: { id: string } }>("/terminals/:id/stream", { websocket: true }, (socket, req) => {
    void streamSession(db, Number(req.params.id), socket);
  });
}
