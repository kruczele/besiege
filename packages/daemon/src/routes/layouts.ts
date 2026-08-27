import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface TerminalLayoutRow {
  id: number;
  campaign_id: number;
  name: string;
  created_at: string;
}

interface MemberRow {
  layout_id: number;
  terminal_session_id: number;
}

function toLayout(row: TerminalLayoutRow, sessionIds: number[]) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    createdAt: row.created_at,
    sessionIds,
  };
}

function memberIdsByLayout(db: Database.Database, layoutIds: number[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  if (layoutIds.length === 0) return map;
  const placeholders = layoutIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT layout_id, terminal_session_id FROM terminal_layout_members
       WHERE layout_id IN (${placeholders}) ORDER BY layout_id ASC, position ASC`,
    )
    .all(...layoutIds) as MemberRow[];
  for (const r of rows) {
    const list = map.get(r.layout_id) ?? [];
    list.push(r.terminal_session_id);
    map.set(r.layout_id, list);
  }
  return map;
}

// Replaces a layout's membership atomically — the grid is edited as "here is
// the new full set of sessions", not incrementally, so a delete-then-reinsert
// inside one transaction is simpler and avoids reordering bugs.
function setMembers(db: Database.Database, layoutId: number, sessionIds: number[]): void {
  const tx = db.transaction((ids: number[]) => {
    db.prepare("DELETE FROM terminal_layout_members WHERE layout_id = ?").run(layoutId);
    const insert = db.prepare(
      "INSERT INTO terminal_layout_members (layout_id, terminal_session_id, position) VALUES (?, ?, ?)",
    );
    ids.forEach((sessionId, position) => insert.run(layoutId, sessionId, position));
  });
  tx(sessionIds);
}

export function registerLayoutRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Params: { campaignId: string } }>(
    "/campaigns/:campaignId/layouts",
    async (req, reply) => {
      const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
      if (!campaign) {
        reply.code(404);
        return { error: "campaign not found" };
      }
      const rows = db
        .prepare("SELECT * FROM terminal_layouts WHERE campaign_id = ? ORDER BY id ASC")
        .all(req.params.campaignId) as TerminalLayoutRow[];
      const members = memberIdsByLayout(db, rows.map((r) => r.id));
      return rows.map((r) => toLayout(r, members.get(r.id) ?? []));
    },
  );

  app.post<{
    Params: { campaignId: string };
    Body: { name?: string; sessionIds?: number[] };
  }>("/campaigns/:campaignId/layouts", async (req, reply) => {
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
    if (!campaign) {
      reply.code(404);
      return { error: "campaign not found" };
    }
    const name = req.body?.name?.trim();
    if (!name) {
      reply.code(400);
      return { error: "name is required" };
    }
    const sessionIds = req.body?.sessionIds ?? [];

    const info = db
      .prepare("INSERT INTO terminal_layouts (campaign_id, name, created_at) VALUES (?, ?, ?)")
      .run(req.params.campaignId, name, new Date().toISOString());
    const layoutId = Number(info.lastInsertRowid);
    setMembers(db, layoutId, sessionIds);

    const row = db.prepare("SELECT * FROM terminal_layouts WHERE id = ?").get(layoutId) as TerminalLayoutRow;
    reply.code(201);
    return toLayout(row, sessionIds);
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<{ name: string; sessionIds: number[] }>;
  }>("/layouts/:id", async (req, reply) => {
    const layout = db.prepare("SELECT * FROM terminal_layouts WHERE id = ?").get(req.params.id) as
      | TerminalLayoutRow
      | undefined;
    if (!layout) {
      reply.code(404);
      return { error: "not found" };
    }

    const body = req.body ?? {};
    if (body.name !== undefined) {
      if (!body.name.trim()) {
        reply.code(400);
        return { error: "name cannot be empty" };
      }
      db.prepare("UPDATE terminal_layouts SET name = ? WHERE id = ?").run(body.name.trim(), layout.id);
    }
    if (body.sessionIds !== undefined) {
      setMembers(db, layout.id, body.sessionIds);
    }

    const updated = db.prepare("SELECT * FROM terminal_layouts WHERE id = ?").get(layout.id) as TerminalLayoutRow;
    const members = memberIdsByLayout(db, [layout.id]);
    return toLayout(updated, members.get(layout.id) ?? []);
  });

  app.delete<{ Params: { id: string } }>("/layouts/:id", async (req, reply) => {
    const result = db.prepare("DELETE FROM terminal_layouts WHERE id = ?").run(req.params.id);
    if (result.changes === 0) {
      reply.code(404);
      return { error: "not found" };
    }
    reply.code(204);
  });
}
