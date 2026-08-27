import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  attachSubscriber,
  killSession,
  resizeSession,
  spawnSession,
  writeToSession,
  type TerminalSessionRow,
} from "../terminals.js";

interface CampaignRow {
  id: number;
  default_dir: string | null;
}

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
});

export function registerTerminalRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Params: { campaignId: string } }>(
    "/campaigns/:campaignId/terminals",
    async (req, reply) => {
      const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
      if (!campaign) {
        reply.code(404);
        return { error: "campaign not found" };
      }
      const rows = db
        .prepare("SELECT * FROM terminal_sessions WHERE campaign_id = ? ORDER BY id DESC")
        .all(req.params.campaignId) as TerminalSessionRow[];
      return rows.map(toSession);
    },
  );

  app.post<{ Params: { campaignId: string }; Body: { cwd?: string; label?: string } }>(
    "/campaigns/:campaignId/terminals",
    async (req, reply) => {
      const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.campaignId) as
        | CampaignRow
        | undefined;
      if (!campaign) {
        reply.code(404);
        return { error: "campaign not found" };
      }

      const cwd = req.body?.cwd?.trim() || campaign.default_dir;
      if (!cwd) {
        reply.code(400);
        return { error: "campaign has no default_dir; pass cwd explicitly" };
      }

      const row = spawnSession(db, Number(req.params.campaignId), cwd, req.body?.label?.trim());
      reply.code(201);
      return toSession(row);
    },
  );

  app.get<{ Params: { id: string } }>("/terminals/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(req.params.id) as
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
