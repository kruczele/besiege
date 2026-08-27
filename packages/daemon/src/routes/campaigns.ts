import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface CampaignRow {
  id: number;
  name: string;
  description: string | null;
  default_dir: string | null;
  created_at: string;
}

interface StepRow {
  id: number;
  campaign_id: number;
  name: string;
  step_order: number;
  created_at: string;
}

interface RepoRow {
  id: number;
  campaign_id: number;
  github_full_name: string;
  created_at: string;
}

const toCampaign = (r: CampaignRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  defaultDir: r.default_dir,
  createdAt: r.created_at,
});

const toStep = (r: StepRow) => ({
  id: r.id,
  campaignId: r.campaign_id,
  name: r.name,
  stepOrder: r.step_order,
  createdAt: r.created_at,
});

const toRepo = (r: RepoRow) => ({
  id: r.id,
  campaignId: r.campaign_id,
  githubFullName: r.github_full_name,
  createdAt: r.created_at,
});

export function registerCampaignRoutes(app: FastifyInstance, db: Database.Database) {
  // Campaigns
  app.get("/campaigns", async () => {
    return (db.prepare("SELECT * FROM campaigns ORDER BY id ASC").all() as CampaignRow[]).map(toCampaign);
  });

  app.post<{ Body: { name?: string; description?: string; default_dir?: string } }>(
    "/campaigns",
    async (req, reply) => {
      const { name, description, default_dir } = req.body ?? {};
      if (!name?.trim()) {
        reply.code(400);
        return { error: "name is required" };
      }
      const info = db
        .prepare("INSERT INTO campaigns (name, description, default_dir, created_at) VALUES (?, ?, ?, ?)")
        .run(name.trim(), description?.trim() ?? null, default_dir?.trim() ?? null, new Date().toISOString());
      const row = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(info.lastInsertRowid) as CampaignRow;
      reply.code(201);
      return toCampaign(row);
    },
  );

  app.patch<{
    Params: { id: string };
    Body: Partial<{ name: string; description: string | null; default_dir: string | null }>;
  }>("/campaigns/:id", async (req, reply) => {
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as
      | CampaignRow
      | undefined;
    if (!campaign) {
      reply.code(404);
      return { error: "not found" };
    }

    const allowed = ["name", "description", "default_dir"] as const;
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const key of allowed) {
      if (key in (req.body ?? {})) {
        updates.push(`${key} = ?`);
        values.push((req.body as Record<string, unknown>)[key]);
      }
    }

    if (updates.length === 0) {
      reply.code(400);
      return { error: "no updatable fields provided" };
    }

    values.push(req.params.id);
    db.prepare(`UPDATE campaigns SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    const updated = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as CampaignRow;
    return toCampaign(updated);
  });

  app.delete<{ Params: { id: string } }>("/campaigns/:id", async (req, reply) => {
    const result = db.prepare("DELETE FROM campaigns WHERE id = ?").run(req.params.id);
    if (result.changes === 0) {
      reply.code(404);
      return { error: "not found" };
    }
    reply.code(204);
  });

  // Steps
  app.get<{ Params: { campaignId: string } }>("/campaigns/:campaignId/steps", async (req, reply) => {
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
    if (!campaign) {
      reply.code(404);
      return { error: "campaign not found" };
    }
    const rows = db
      .prepare("SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY step_order ASC")
      .all(req.params.campaignId) as StepRow[];
    return rows.map(toStep);
  });

  app.post<{ Params: { campaignId: string }; Body: { name?: string; step_order?: number } }>(
    "/campaigns/:campaignId/steps",
    async (req, reply) => {
      const { name, step_order } = req.body ?? {};
      if (!name?.trim() || step_order === undefined) {
        reply.code(400);
        return { error: "name and step_order are required" };
      }
      const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
      if (!campaign) {
        reply.code(404);
        return { error: "campaign not found" };
      }
      try {
        const info = db
          .prepare(
            "INSERT INTO campaign_steps (campaign_id, name, step_order, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(req.params.campaignId, name.trim(), step_order, new Date().toISOString());
        const row = db
          .prepare("SELECT * FROM campaign_steps WHERE id = ?")
          .get(info.lastInsertRowid) as StepRow;
        reply.code(201);
        return toStep(row);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("UNIQUE")) {
          reply.code(409);
          return { error: "step_order already exists in this campaign" };
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { campaignId: string; stepId: string } }>(
    "/campaigns/:campaignId/steps/:stepId",
    async (req, reply) => {
      const result = db
        .prepare("DELETE FROM campaign_steps WHERE id = ? AND campaign_id = ?")
        .run(req.params.stepId, req.params.campaignId);
      if (result.changes === 0) {
        reply.code(404);
        return { error: "not found" };
      }
      reply.code(204);
    },
  );

  // Repos
  app.get<{ Params: { campaignId: string }; Querystring: { name?: string } }>(
    "/campaigns/:campaignId/repos",
    async (req, reply) => {
      const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
      if (!campaign) {
        reply.code(404);
        return { error: "campaign not found" };
      }
      const rows = req.query.name
        ? (db
            .prepare(
              "SELECT * FROM campaign_repos WHERE campaign_id = ? AND github_full_name = ? ORDER BY id ASC",
            )
            .all(req.params.campaignId, req.query.name) as RepoRow[])
        : (db
            .prepare("SELECT * FROM campaign_repos WHERE campaign_id = ? ORDER BY id ASC")
            .all(req.params.campaignId) as RepoRow[]);
      return rows.map(toRepo);
    },
  );

  app.post<{ Params: { campaignId: string }; Body: { github_full_name?: string } }>(
    "/campaigns/:campaignId/repos",
    async (req, reply) => {
      const { github_full_name } = req.body ?? {};
      if (!github_full_name?.trim()) {
        reply.code(400);
        return { error: "github_full_name is required" };
      }
      const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
      if (!campaign) {
        reply.code(404);
        return { error: "campaign not found" };
      }
      try {
        const info = db
          .prepare(
            "INSERT INTO campaign_repos (campaign_id, github_full_name, created_at) VALUES (?, ?, ?)",
          )
          .run(req.params.campaignId, github_full_name.trim(), new Date().toISOString());
        const row = db
          .prepare("SELECT * FROM campaign_repos WHERE id = ?")
          .get(info.lastInsertRowid) as RepoRow;
        reply.code(201);
        return toRepo(row);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("UNIQUE")) {
          reply.code(409);
          return { error: "repo already registered in this campaign" };
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { campaignId: string; repoId: string } }>(
    "/campaigns/:campaignId/repos/:repoId",
    async (req, reply) => {
      const result = db
        .prepare("DELETE FROM campaign_repos WHERE id = ? AND campaign_id = ?")
        .run(req.params.repoId, req.params.campaignId);
      if (result.changes === 0) {
        reply.code(404);
        return { error: "not found" };
      }
      reply.code(204);
    },
  );
}
