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
  since: r.since,
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
    Body: { name?: string; context?: string; since?: string };
  }>("/campaigns/:campaignId/steps/:stepId/tasks", async (req, reply) => {
    const { name, context, since } = req.body ?? {};
    if (!name?.trim() || !context?.trim() || !since?.trim()) {
      reply.code(400);
      return { error: "name, context, and since are required" };
    }
    const step = db
      .prepare("SELECT id FROM campaign_steps WHERE id = ? AND campaign_id = ?")
      .get(req.params.stepId, req.params.campaignId);
    if (!step) {
      reply.code(404);
      return { error: "step not found" };
    }

    const now = new Date().toISOString();
    const taskInfo = db
      .prepare(
        "INSERT INTO task_definitions (step_id, name, context, since, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(req.params.stepId, name.trim(), context.trim(), since.trim(), now);

    const taskId = taskInfo.lastInsertRowid;

    // Retroactive assignment: any PR in this step created before `since` gets this task as pending.
    const prsToAssign = db
      .prepare(
        "SELECT id FROM prs WHERE step_id = ? AND created_at < ?",
      )
      .all(req.params.stepId, since) as { id: number }[];

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
}
