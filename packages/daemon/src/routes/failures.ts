import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface FailureSignatureRow {
  id: number;
  campaign_id: number;
  signature: string;
  fix_context: string;
  hit_count: number;
  created_at: string;
  updated_at: string;
}

const toFailure = (r: FailureSignatureRow) => ({
  id: r.id,
  campaignId: r.campaign_id,
  signature: r.signature,
  fixContext: r.fix_context,
  hitCount: r.hit_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function registerFailureRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Params: { campaignId: string }; Querystring: { signature?: string } }>(
    "/campaigns/:campaignId/failures",
    async (req, reply) => {
      const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
      if (!campaign) {
        reply.code(404);
        return { error: "campaign not found" };
      }
      if (req.query.signature) {
        const row = db
          .prepare(
            "SELECT * FROM failure_signatures WHERE campaign_id = ? AND signature = ?",
          )
          .get(req.params.campaignId, req.query.signature) as FailureSignatureRow | undefined;
        return row ? toFailure(row) : null;
      }
      const rows = db
        .prepare(
          "SELECT * FROM failure_signatures WHERE campaign_id = ? ORDER BY hit_count DESC, id ASC",
        )
        .all(req.params.campaignId) as FailureSignatureRow[];
      return rows.map(toFailure);
    },
  );

  // Upsert: create new or increment hit_count + update fix_context on existing.
  app.post<{
    Params: { campaignId: string };
    Body: { signature?: string; fix_context?: string };
  }>("/campaigns/:campaignId/failures", async (req, reply) => {
    const { signature, fix_context } = req.body ?? {};
    if (!signature?.trim() || !fix_context?.trim()) {
      reply.code(400);
      return { error: "signature and fix_context are required" };
    }
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
    if (!campaign) {
      reply.code(404);
      return { error: "campaign not found" };
    }

    const now = new Date().toISOString();
    const existing = db
      .prepare(
        "SELECT id FROM failure_signatures WHERE campaign_id = ? AND signature = ?",
      )
      .get(req.params.campaignId, signature.trim()) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        "UPDATE failure_signatures SET fix_context = ?, hit_count = hit_count + 1, updated_at = ? WHERE id = ?",
      ).run(fix_context.trim(), now, existing.id);
      const row = db
        .prepare("SELECT * FROM failure_signatures WHERE id = ?")
        .get(existing.id) as FailureSignatureRow;
      return toFailure(row);
    }

    const info = db
      .prepare(
        "INSERT INTO failure_signatures (campaign_id, signature, fix_context, hit_count, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      )
      .run(req.params.campaignId, signature.trim(), fix_context.trim(), now, now);
    const row = db
      .prepare("SELECT * FROM failure_signatures WHERE id = ?")
      .get(info.lastInsertRowid) as FailureSignatureRow;
    reply.code(201);
    return toFailure(row);
  });

  app.delete<{ Params: { campaignId: string; id: string } }>(
    "/campaigns/:campaignId/failures/:id",
    async (req, reply) => {
      const result = db
        .prepare("DELETE FROM failure_signatures WHERE id = ? AND campaign_id = ?")
        .run(req.params.id, req.params.campaignId);
      if (result.changes === 0) {
        reply.code(404);
        return { error: "not found" };
      }
      reply.code(204);
    },
  );
}
