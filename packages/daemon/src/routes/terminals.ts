import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { findAgentConfig } from "../agent-config.js";
import {
  attachSubscriber,
  killSession,
  removeSession,
  resizeSession,
  resolveResumeConversationId,
  spawnSession,
  writeToSession,
  type TerminalSessionRow,
} from "../terminals.js";
import { pruneSessionFromLayouts } from "./layouts.js";

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
});

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
    };
  }>("/campaigns/:campaignId/terminals", async (req, reply) => {
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.campaignId) as
      | CampaignRow
      | undefined;
    if (!campaign) {
      reply.code(404);
      return { error: "campaign not found" };
    }

    if (req.body?.resumeFromTerminalId !== undefined) {
      const prior = db
        .prepare("SELECT * FROM terminal_sessions WHERE id = ? AND campaign_id = ?")
        .get(req.body.resumeFromTerminalId, req.params.campaignId) as TerminalSessionRow | undefined;
      if (!prior) {
        reply.code(404);
        return { error: "session to resume from not found" };
      }
      if (!prior.agent_adapter_name) {
        reply.code(400);
        return { error: "session has no resumable agent conversation" };
      }
      const adapter = findAgentConfig(prior.agent_adapter_name);
      if (!adapter?.resumeFlag) {
        reply.code(400);
        return { error: "adapter does not support resume" };
      }
      const resumeConversationId = resolveResumeConversationId(adapter, prior);
      if (!resumeConversationId) {
        reply.code(400);
        return { error: "session has no resumable agent conversation" };
      }
      const resumed = spawnSession(
        db,
        Number(req.params.campaignId),
        prior.cwd,
        prior.label ?? undefined,
        prior.agent_adapter_name,
        Boolean(prior.yolo),
        prior.extra_args ?? undefined,
        prior.agent_session_id ?? undefined,
        resumeConversationId,
      );
      const withAgent = db
        .prepare(`${SELECT_SESSION} WHERE ts.id = ?`)
        .get(resumed.id) as TerminalSessionRow;
      reply.code(201);
      return toSession(withAgent);
    }

    const cwd = req.body?.cwd?.trim() || campaign.default_dir;
    if (!cwd) {
      reply.code(400);
      return { error: "campaign has no default_dir; pass cwd explicitly" };
    }

    const agentAdapterName = req.body?.agentAdapterName;
    if (agentAdapterName !== undefined && !findAgentConfig(agentAdapterName)) {
      reply.code(400);
      return { error: "agent adapter not found" };
    }

    const row = spawnSession(
      db,
      Number(req.params.campaignId),
      cwd,
      req.body?.label?.trim(),
      agentAdapterName,
      req.body?.yolo,
      req.body?.extraArgs,
    );
    const withAgent = db.prepare(`${SELECT_SESSION} WHERE ts.id = ?`).get(row.id) as TerminalSessionRow;
    reply.code(201);
    return toSession(withAgent);
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
    killSession(db, Number(req.params.id));
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
    const id = Number(req.params.id);
    const attached = attachSubscriber(id, socket);
    if (!attached) {
      socket.send(JSON.stringify({ type: "error", message: "session not active" }));
      socket.close();
      return;
    }

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
        writeToSession(id, m.data);
      } else if (m.type === "resize" && typeof m.cols === "number" && typeof m.rows === "number") {
        resizeSession(id, m.cols, m.rows);
      }
    });
  });
}
