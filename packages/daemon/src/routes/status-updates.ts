import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface StatusUpdateRow {
  id: number;
  session_id: string;
  cwd: string | null;
  repo: string | null;
  pr_number: number | null;
  summary: string;
  created_at: string;
}

function toStatusUpdate(row: StatusUpdateRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    cwd: row.cwd,
    repo: row.repo,
    prNumber: row.pr_number,
    prUrl: row.repo && row.pr_number ? `https://github.com/${row.repo}/pull/${row.pr_number}` : null,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function registerStatusUpdateRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Querystring: { limit?: string } }>("/status-updates", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const rows = db
      .prepare("SELECT * FROM status_updates ORDER BY id DESC LIMIT ?")
      .all(limit) as StatusUpdateRow[];
    return rows.map(toStatusUpdate);
  });

  app.post<{
    Body: { sessionId?: string; cwd?: string; repo?: string; prNumber?: number; summary?: string };
  }>("/status-updates", async (req, reply) => {
    const { sessionId, cwd, repo, prNumber, summary } = req.body ?? {};
    if (!sessionId?.trim() || !summary?.trim()) {
      reply.code(400);
      return { error: "sessionId and summary are both required" };
    }
    if (repo !== undefined && !REPO_RE.test(repo)) {
      reply.code(400);
      return { error: 'repo must look like "org/name"' };
    }
    if (prNumber !== undefined && (!Number.isInteger(prNumber) || prNumber <= 0)) {
      reply.code(400);
      return { error: "prNumber must be a positive integer" };
    }
    if (prNumber !== undefined && !repo) {
      reply.code(400);
      return { error: "prNumber requires repo" };
    }
    const info = db
      .prepare(
        "INSERT INTO status_updates (session_id, cwd, repo, pr_number, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        sessionId.trim(),
        cwd?.trim() ?? null,
        repo ?? null,
        prNumber ?? null,
        summary.trim(),
        new Date().toISOString(),
      );
    const row = db
      .prepare("SELECT * FROM status_updates WHERE id = ?")
      .get(info.lastInsertRowid) as StatusUpdateRow;
    reply.code(201);
    return toStatusUpdate(row);
  });
}
