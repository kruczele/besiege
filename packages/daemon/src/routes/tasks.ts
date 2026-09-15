import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface TaskDefinitionRow {
  id: number;
  step_id: number;
  name: string;
  context: string;
  since: string;
  retired_at: string | null;
  created_at: string;
}

const toTask = (r: TaskDefinitionRow) => ({
  id: r.id,
  stepId: r.step_id,
  name: r.name,
  context: r.context,
  retiredAt: r.retired_at,
  createdAt: r.created_at,
});

export function registerTaskRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Params: { campaignId: string; stepId: string }; Querystring: { includeRetired?: string } }>(
    "/campaigns/:campaignId/steps/:stepId/tasks",
    async (req, reply) => {
      const step = db
        .prepare("SELECT id FROM campaign_steps WHERE id = ? AND campaign_id = ?")
        .get(req.params.stepId, req.params.campaignId);
      if (!step) {
        reply.code(404);
        return { error: "step not found" };
      }
      const includeRetired = req.query.includeRetired === "true";
      const rows = includeRetired
        ? (db
            .prepare("SELECT * FROM task_definitions WHERE step_id = ? ORDER BY id ASC")
            .all(req.params.stepId) as TaskDefinitionRow[])
        : (db
            .prepare(
              "SELECT * FROM task_definitions WHERE step_id = ? AND retired_at IS NULL ORDER BY id ASC",
            )
            .all(req.params.stepId) as TaskDefinitionRow[]);
      return rows.map(toTask);
    },
  );

  app.post<{
    Params: { campaignId: string; stepId: string };
    Body: { name?: string; context?: string };
  }>("/campaigns/:campaignId/steps/:stepId/tasks", async (req, reply) => {
    const { name, context } = req.body ?? {};
    if (!name?.trim() || !context?.trim()) {
      reply.code(400);
      return { error: "name and context are required" };
    }
    const step = db
      .prepare("SELECT id FROM campaign_steps WHERE id = ? AND campaign_id = ?")
      .get(req.params.stepId, req.params.campaignId);
    if (!step) {
      reply.code(404);
      return { error: "step not found" };
    }

    // A task always applies "now" — every PR already in this step gets it
    // retroactively, and any PR opened after should already reflect it via
    // the primary work. There is no such thing as scheduling a task for
    // later; `since` (the column, kept as-is) is just this timestamp.
    const now = new Date().toISOString();
    const taskInfo = db
      .prepare(
        "INSERT INTO task_definitions (step_id, name, context, since, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(req.params.stepId, name.trim(), context.trim(), now, now);

    const taskId = taskInfo.lastInsertRowid;

    // Retroactive assignment: every PR already in this step gets this task as pending.
    const prsToAssign = db
      .prepare(
        "SELECT id FROM prs WHERE step_id = ? AND created_at < ?",
      )
      .all(req.params.stepId, now) as { id: number }[];

    const insertPending = db.prepare(
      "INSERT OR IGNORE INTO pr_pending_tasks (pr_id, task_definition_id, created_at) VALUES (?, ?, ?)",
    );
    db.transaction(() => {
      for (const pr of prsToAssign) {
        insertPending.run(pr.id, taskId, now);
      }
    })();

    const row = db
      .prepare("SELECT * FROM task_definitions WHERE id = ?")
      .get(taskId) as TaskDefinitionRow;
    reply.code(201);
    return toTask(row);
  });

  app.post<{ Params: { campaignId: string; stepId: string; taskId: string } }>(
    "/campaigns/:campaignId/steps/:stepId/tasks/:taskId/retire",
    async (req, reply) => {
      const task = db
        .prepare(
          "SELECT td.id FROM task_definitions td JOIN campaign_steps cs ON cs.id = td.step_id WHERE td.id = ? AND cs.campaign_id = ? AND td.step_id = ?",
        )
        .get(req.params.taskId, req.params.campaignId, req.params.stepId);
      if (!task) {
        reply.code(404);
        return { error: "task not found" };
      }
      db.prepare("UPDATE task_definitions SET retired_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        req.params.taskId,
      );
      const row = db
        .prepare("SELECT * FROM task_definitions WHERE id = ?")
        .get(req.params.taskId) as TaskDefinitionRow;
      return toTask(row);
    },
  );

  app.patch<{
    Params: { campaignId: string; stepId: string; taskId: string };
    Body: Partial<{ name: string; context: string }>;
  }>("/campaigns/:campaignId/steps/:stepId/tasks/:taskId", async (req, reply) => {
    const task = db
      .prepare(
        "SELECT td.id FROM task_definitions td JOIN campaign_steps cs ON cs.id = td.step_id WHERE td.id = ? AND cs.campaign_id = ? AND td.step_id = ?",
      )
      .get(req.params.taskId, req.params.campaignId, req.params.stepId);
    if (!task) {
      reply.code(404);
      return { error: "task not found" };
    }

    const body = req.body ?? {};
    const allowed = ["name", "context"] as const;
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const key of allowed) {
      const value = body[key];
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

    values.push(req.params.taskId);
    db.prepare(`UPDATE task_definitions SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    const updated = db
      .prepare("SELECT * FROM task_definitions WHERE id = ?")
      .get(req.params.taskId) as TaskDefinitionRow;
    return toTask(updated);
  });

  app.delete<{ Params: { campaignId: string; stepId: string; taskId: string } }>(
    "/campaigns/:campaignId/steps/:stepId/tasks/:taskId",
    async (req, reply) => {
      const task = db
        .prepare(
          "SELECT td.id FROM task_definitions td JOIN campaign_steps cs ON cs.id = td.step_id WHERE td.id = ? AND cs.campaign_id = ? AND td.step_id = ?",
        )
        .get(req.params.taskId, req.params.campaignId, req.params.stepId);
      if (!task) {
        reply.code(404);
        return { error: "task not found" };
      }
      db.transaction(() => {
        db.prepare("DELETE FROM pr_pending_tasks WHERE task_definition_id = ?").run(req.params.taskId);
        db.prepare("DELETE FROM task_definitions WHERE id = ?").run(req.params.taskId);
      })();
      reply.code(204);
    },
  );
}
