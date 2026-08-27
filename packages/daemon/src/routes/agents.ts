import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface AgentAdapterRow {
  id: number;
  name: string;
  binary: string;
  yolo_flag: string | null;
  created_at: string;
}

function toAdapter(row: AgentAdapterRow) {
  return {
    id: row.id,
    name: row.name,
    binary: row.binary,
    yoloFlag: row.yolo_flag,
    createdAt: row.created_at,
  };
}

export function registerAgentRoutes(app: FastifyInstance, db: Database.Database) {
  app.get("/agents", async () => {
    const rows = db.prepare("SELECT * FROM agent_adapters ORDER BY id ASC").all() as AgentAdapterRow[];
    return rows.map(toAdapter);
  });

  app.post<{ Body: { name?: string; binary?: string; yoloFlag?: string } }>("/agents", async (req, reply) => {
    const { name, binary, yoloFlag } = req.body ?? {};
    if (!name?.trim() || !binary?.trim()) {
      reply.code(400);
      return { error: "name and binary are both required" };
    }
    const info = db
      .prepare("INSERT INTO agent_adapters (name, binary, yolo_flag, created_at) VALUES (?, ?, ?, ?)")
      .run(name.trim(), binary.trim(), yoloFlag?.trim() || null, new Date().toISOString());
    const row = db
      .prepare("SELECT * FROM agent_adapters WHERE id = ?")
      .get(info.lastInsertRowid) as AgentAdapterRow;
    reply.code(201);
    return toAdapter(row);
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<{ name: string; binary: string; yoloFlag: string }>;
  }>("/agents/:id", async (req, reply) => {
    const adapter = db.prepare("SELECT * FROM agent_adapters WHERE id = ?").get(req.params.id) as
      | AgentAdapterRow
      | undefined;
    if (!adapter) {
      reply.code(404);
      return { error: "not found" };
    }

    const body = req.body ?? {};
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      if (!body.name.trim()) {
        reply.code(400);
        return { error: "name cannot be empty" };
      }
      updates.push("name = ?");
      values.push(body.name.trim());
    }

    if (body.binary !== undefined) {
      if (!body.binary.trim()) {
        reply.code(400);
        return { error: "binary cannot be empty" };
      }
      updates.push("binary = ?");
      values.push(body.binary.trim());
    }

    // Unlike name/binary, an empty yoloFlag is meaningful (this adapter has
    // no skip-permissions flag) rather than an invalid update.
    if (body.yoloFlag !== undefined) {
      updates.push("yolo_flag = ?");
      values.push(body.yoloFlag.trim() || null);
    }

    if (updates.length === 0) {
      reply.code(400);
      return { error: "no updatable fields provided" };
    }

    values.push(req.params.id);
    db.prepare(`UPDATE agent_adapters SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    const updated = db.prepare("SELECT * FROM agent_adapters WHERE id = ?").get(req.params.id) as AgentAdapterRow;
    return toAdapter(updated);
  });

  app.delete<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
    const result = db.prepare("DELETE FROM agent_adapters WHERE id = ?").run(req.params.id);
    if (result.changes === 0) {
      reply.code(404);
      return { error: "not found" };
    }
    reply.code(204);
  });
}
