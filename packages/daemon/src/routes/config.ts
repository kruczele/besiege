import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { minimatch } from "minimatch";

interface ConfigRuleRow {
  id: number;
  pattern: string;
  context: string;
  created_at: string;
}

function toRule(row: ConfigRuleRow) {
  return { id: row.id, pattern: row.pattern, context: row.context, createdAt: row.created_at };
}

export function resolveContext(db: Database.Database, cwd: string) {
  const rows = db.prepare("SELECT * FROM config_rules ORDER BY id ASC").all() as ConfigRuleRow[];
  // Bare "*" is documented as "always match" — but in real glob semantics
  // (minimatch, bash, gitignore) a single "*" never spans "/" the way a
  // multi-segment cwd needs, so it has to be special-cased rather than
  // left to minimatch. Every other pattern goes through minimatch as-is.
  const matched = rows.filter(
    (row) => row.pattern === "*" || minimatch(cwd, row.pattern, { dot: true }),
  );
  return {
    context: matched.map((row) => row.context).join("\n\n"),
    matchedRuleIds: matched.map((row) => row.id),
  };
}

export function registerConfigRoutes(app: FastifyInstance, db: Database.Database) {
  app.get("/config/rules", async () => {
    const rows = db.prepare("SELECT * FROM config_rules ORDER BY id ASC").all() as ConfigRuleRow[];
    return rows.map(toRule);
  });

  app.post<{ Body: { pattern?: string; context?: string } }>("/config/rules", async (req, reply) => {
    const { pattern, context } = req.body ?? {};
    if (!pattern?.trim() || !context?.trim()) {
      reply.code(400);
      return { error: "pattern and context are both required" };
    }
    const info = db
      .prepare("INSERT INTO config_rules (pattern, context, created_at) VALUES (?, ?, ?)")
      .run(pattern.trim(), context.trim(), new Date().toISOString());
    const row = db
      .prepare("SELECT * FROM config_rules WHERE id = ?")
      .get(info.lastInsertRowid) as ConfigRuleRow;
    reply.code(201);
    return toRule(row);
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<{ pattern: string; context: string }>;
  }>("/config/rules/:id", async (req, reply) => {
    const rule = db.prepare("SELECT * FROM config_rules WHERE id = ?").get(req.params.id) as
      | ConfigRuleRow
      | undefined;
    if (!rule) {
      reply.code(404);
      return { error: "not found" };
    }

    const allowed = ["pattern", "context"] as const;
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const key of allowed) {
      const value = (req.body ?? {})[key];
      if (value === undefined) continue;
      if (!value.trim()) {
        reply.code(400);
        return { error: `${key} cannot be empty` };
      }
      updates.push(`${key} = ?`);
      values.push(value.trim());
    }

    if (updates.length === 0) {
      reply.code(400);
      return { error: "no updatable fields provided" };
    }

    values.push(req.params.id);
    db.prepare(`UPDATE config_rules SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    const updated = db.prepare("SELECT * FROM config_rules WHERE id = ?").get(req.params.id) as ConfigRuleRow;
    return toRule(updated);
  });

  app.delete<{ Params: { id: string } }>("/config/rules/:id", async (req, reply) => {
    const result = db.prepare("DELETE FROM config_rules WHERE id = ?").run(req.params.id);
    if (result.changes === 0) {
      reply.code(404);
      return { error: "not found" };
    }
    reply.code(204);
  });

  app.get<{ Querystring: { cwd?: string } }>("/config/resolve", async (req, reply) => {
    if (!req.query.cwd) {
      reply.code(400);
      return { error: "cwd query param is required" };
    }
    return resolveContext(db, req.query.cwd);
  });
}
