import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface NotificationRow {
  id: number;
  session_id: string;
  cwd: string | null;
  message: string;
  kind: string;
  created_at: string;
  acknowledged_at: string | null;
  superseded_at: string | null;
}

function toNotification(row: NotificationRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    cwd: row.cwd,
    message: row.message,
    kind: row.kind,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    supersededAt: row.superseded_at,
  };
}

export function registerNotificationRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Querystring: { unacknowledged?: string } }>("/notifications", async (req) => {
    const rows = req.query.unacknowledged === "true"
      ? (db
          .prepare(
            "SELECT * FROM notifications WHERE acknowledged_at IS NULL AND superseded_at IS NULL ORDER BY id DESC",
          )
          .all() as NotificationRow[])
      : (db.prepare("SELECT * FROM notifications ORDER BY id DESC").all() as NotificationRow[]);
    return rows.map(toNotification);
  });

  app.post<{ Body: { sessionId?: string; cwd?: string; message?: string } }>(
    "/notifications",
    async (req, reply) => {
      const { sessionId, cwd, message } = req.body ?? {};
      if (!sessionId?.trim() || !message?.trim()) {
        reply.code(400);
        return { error: "sessionId and message are both required" };
      }
      const now = new Date().toISOString();
      const row = db.transaction(() => {
        // One agent session should only ever have one active (unacknowledged)
        // notification in the inbox — an agent that fires off several in a
        // row (finishes one blocker, immediately hits another) would
        // otherwise pile up stale rows for the same session. The new one
        // supersedes whatever was still active for this session_id.
        db.prepare(
          "UPDATE notifications SET superseded_at = ? WHERE session_id = ? AND acknowledged_at IS NULL AND superseded_at IS NULL",
        ).run(now, sessionId.trim());
        const info = db
          .prepare(
            "INSERT INTO notifications (session_id, cwd, message, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(sessionId.trim(), cwd?.trim() ?? null, message.trim(), now);
        return db.prepare("SELECT * FROM notifications WHERE id = ?").get(info.lastInsertRowid) as NotificationRow;
      })();
      reply.code(201);
      return toNotification(row);
    },
  );

  app.post<{ Params: { id: string } }>("/notifications/:id/ack", async (req, reply) => {
    const result = db
      .prepare("UPDATE notifications SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL")
      .run(new Date().toISOString(), req.params.id);
    if (result.changes === 0) {
      reply.code(404);
      return { error: "not found or already acknowledged" };
    }
    const row = db
      .prepare("SELECT * FROM notifications WHERE id = ?")
      .get(req.params.id) as NotificationRow;
    return toNotification(row);
  });
}
