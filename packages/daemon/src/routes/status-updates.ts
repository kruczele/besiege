import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface StatusUpdateRow {
  id: number;
  session_id: string;
  cwd: string | null;
  repo: string | null;
  pr_number: number | null;
  pr_links: string | null;
  summary: string;
  created_at: string;
}

interface PrLink {
  repo: string;
  number: number;
}

const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

function parsePrUrl(url: unknown): PrLink | null {
  const m = typeof url === "string" ? PR_URL_RE.exec(url.trim()) : null;
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

function prLinksOf(row: StatusUpdateRow): PrLink[] {
  if (row.pr_links) return JSON.parse(row.pr_links) as PrLink[];
  return row.repo && row.pr_number ? [{ repo: row.repo, number: row.pr_number }] : [];
}

function toStatusUpdate(row: StatusUpdateRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    cwd: row.cwd,
    repo: row.repo,
    prs: prLinksOf(row).map((pr) => ({ ...pr, url: `https://github.com/${pr.repo}/pull/${pr.number}` })),
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export function registerStatusUpdateRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Querystring: { limit?: string } }>("/status-updates", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const rows = db
      .prepare("SELECT * FROM status_updates ORDER BY id DESC LIMIT ?")
      .all(limit) as StatusUpdateRow[];
    return rows.map(toStatusUpdate);
  });

  app.post<{
    Body: { sessionId?: string; cwd?: string; prUrls?: string[]; summary?: string };
  }>("/status-updates", async (req, reply) => {
    const { sessionId, cwd, prUrls, summary } = req.body ?? {};
    if (!sessionId?.trim() || !summary?.trim()) {
      reply.code(400);
      return { error: "sessionId and summary are both required" };
    }
    const prs: PrLink[] = [];
    for (const url of prUrls ?? []) {
      const pr = parsePrUrl(url);
      if (!pr) {
        reply.code(400);
        return { error: `prUrls entries must be GitHub PR URLs like https://github.com/org/name/pull/1, got ${JSON.stringify(url)}` };
      }
      if (!prs.some((p) => p.repo === pr.repo && p.number === pr.number)) prs.push(pr);
    }
    const info = db
      .prepare(
        "INSERT INTO status_updates (session_id, cwd, pr_links, summary, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        sessionId.trim(),
        cwd?.trim() ?? null,
        prs.length > 0 ? JSON.stringify(prs) : null,
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
