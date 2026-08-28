import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { emptyTree, remapSessionIds, sessionIdsInTree, type PaneNode } from "../layout-tree.js";

interface TerminalLayoutRow {
  id: number;
  campaign_id: number;
  name: string;
  created_at: string;
  layout_tree: string;
  is_name_custom: number;
}

function toLayout(row: TerminalLayoutRow) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    createdAt: row.created_at,
    isNameCustom: Boolean(row.is_name_custom),
    tree: JSON.parse(row.layout_tree) as PaneNode,
  };
}

// Called from routes/terminals.ts when a session is deleted — removes it
// from every layout in its campaign that still references it, so a pane
// never shows a dead session id, it just becomes empty and relaunchable.
export function pruneSessionFromLayouts(db: Database.Database, campaignId: number, sessionId: number): void {
  const rows = db
    .prepare("SELECT * FROM terminal_layouts WHERE campaign_id = ?")
    .all(campaignId) as TerminalLayoutRow[];
  const update = db.prepare("UPDATE terminal_layouts SET layout_tree = ? WHERE id = ?");
  for (const row of rows) {
    const tree = JSON.parse(row.layout_tree) as PaneNode;
    if (!sessionIdsInTree(tree).includes(sessionId)) continue;
    update.run(JSON.stringify(remapSessionIds(tree, new Map([[sessionId, null]]))), row.id);
  }
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
      return rows.map(toLayout);
    },
  );

  app.post<{
    Params: { campaignId: string };
    Body: { name?: string; tree?: PaneNode };
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
    const tree = req.body?.tree ?? emptyTree();

    const info = db
      .prepare(
        "INSERT INTO terminal_layouts (campaign_id, name, created_at, layout_tree, is_name_custom) VALUES (?, ?, ?, ?, 0)",
      )
      .run(req.params.campaignId, name, new Date().toISOString(), JSON.stringify(tree));
    const row = db
      .prepare("SELECT * FROM terminal_layouts WHERE id = ?")
      .get(info.lastInsertRowid) as TerminalLayoutRow;
    reply.code(201);
    return toLayout(row);
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<{ name: string; isNameCustom: boolean; tree: PaneNode }>;
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
    if (body.isNameCustom !== undefined) {
      db.prepare("UPDATE terminal_layouts SET is_name_custom = ? WHERE id = ?").run(
        body.isNameCustom ? 1 : 0,
        layout.id,
      );
    }
    if (body.tree !== undefined) {
      db.prepare("UPDATE terminal_layouts SET layout_tree = ? WHERE id = ?").run(
        JSON.stringify(body.tree),
        layout.id,
      );
    }

    const updated = db.prepare("SELECT * FROM terminal_layouts WHERE id = ?").get(layout.id) as TerminalLayoutRow;
    return toLayout(updated);
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
