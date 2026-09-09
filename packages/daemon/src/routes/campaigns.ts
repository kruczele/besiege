import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { removeSession } from "../terminals.js";

interface CampaignRow {
  id: number;
  name: string;
  description: string | null;
  default_dir: string | null;
  created_at: string;
  archived_at: string | null;
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
  pinned: number;
  created_at: string;
}

const toCampaign = (r: CampaignRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  defaultDir: r.default_dir,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
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
  pinned: r.pinned === 1,
  createdAt: r.created_at,
});

export function registerCampaignRoutes(app: FastifyInstance, db: Database.Database) {
  // Campaigns
  // Archived campaigns are hidden by default (the switcher/list shouldn't
  // fill up with done-with campaigns) — pass ?includeArchived=1 to see them
  // too, used by the GUI's "show archived" toggle.
  app.get<{ Querystring: { includeArchived?: string } }>("/campaigns", async (req) => {
    const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";
    const rows = includeArchived
      ? (db.prepare("SELECT * FROM campaigns ORDER BY id ASC").all() as CampaignRow[])
      : (db.prepare("SELECT * FROM campaigns WHERE archived_at IS NULL ORDER BY id ASC").all() as CampaignRow[]);
    return rows.map(toCampaign);
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

  // Archive/unarchive: reversible, doesn't touch anything underneath the
  // campaign — just flips whether it shows up in the default list/switcher.
  app.post<{ Params: { id: string } }>("/campaigns/:id/archive", async (req, reply) => {
    const result = db
      .prepare("UPDATE campaigns SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(new Date().toISOString(), req.params.id);
    const row = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as CampaignRow | undefined;
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    if (result.changes === 0 && !row.archived_at) {
      // Row exists but wasn't touched for a reason other than "already
      // archived" — shouldn't happen, but don't silently report success.
      reply.code(409);
      return { error: "could not archive" };
    }
    return toCampaign(row);
  });

  app.post<{ Params: { id: string } }>("/campaigns/:id/unarchive", async (req, reply) => {
    db.prepare("UPDATE campaigns SET archived_at = NULL WHERE id = ?").run(req.params.id);
    const row = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as CampaignRow | undefined;
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    return toCampaign(row);
  });

  // Permanent, cascading delete — unlike archive, this really does remove
  // everything underneath the campaign. Foreign keys are enforced (db.ts
  // pragma), so children must go first, in dependency order; only
  // terminal_layouts/terminal_layout_members cascade on their own (0018).
  // Live terminal sessions go through removeSession so their pty actually
  // gets killed, not just the row deleted out from under it.
  app.delete<{ Params: { id: string } }>("/campaigns/:id", async (req, reply) => {
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.id);
    if (!campaign) {
      reply.code(404);
      return { error: "not found" };
    }

    const sessionIds = (
      db.prepare("SELECT id FROM terminal_sessions WHERE campaign_id = ?").all(req.params.id) as { id: number }[]
    ).map((r) => r.id);
    for (const id of sessionIds) removeSession(db, id);

    db.transaction(() => {
      db.prepare(
        `DELETE FROM pr_pending_tasks WHERE
           pr_id IN (SELECT p.id FROM prs p JOIN campaign_steps cs ON cs.id = p.step_id WHERE cs.campaign_id = ?)
           OR task_definition_id IN (SELECT id FROM task_definitions WHERE step_id IN
             (SELECT id FROM campaign_steps WHERE campaign_id = ?))`,
      ).run(req.params.id, req.params.id);
      db.prepare(
        `DELETE FROM pr_claims WHERE pr_id IN
           (SELECT p.id FROM prs p JOIN campaign_steps cs ON cs.id = p.step_id WHERE cs.campaign_id = ?)`,
      ).run(req.params.id);
      db.prepare(`DELETE FROM prs WHERE step_id IN (SELECT id FROM campaign_steps WHERE campaign_id = ?)`).run(
        req.params.id,
      );
      db.prepare(
        `DELETE FROM task_definitions WHERE step_id IN (SELECT id FROM campaign_steps WHERE campaign_id = ?)`,
      ).run(req.params.id);
      db.prepare("DELETE FROM failure_signatures WHERE campaign_id = ?").run(req.params.id);
      db.prepare("DELETE FROM terminal_layouts WHERE campaign_id = ?").run(req.params.id);
      db.prepare("DELETE FROM campaign_steps WHERE campaign_id = ?").run(req.params.id);
      db.prepare("DELETE FROM campaign_repos WHERE campaign_id = ?").run(req.params.id);
      db.prepare("DELETE FROM campaigns WHERE id = ?").run(req.params.id);
    })();

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
          // Concurrent register_pr entries race resolveStepId's check-then-insert
          // for the same step name (mcp.ts) — the loser here isn't a real
          // conflict, it's the step the winner just created. Hand back that row
          // instead of a 409 the caller has no way to resolve to a real id.
          const existing = db
            .prepare("SELECT * FROM campaign_steps WHERE campaign_id = ? AND name = ? COLLATE NOCASE")
            .get(req.params.campaignId, name.trim()) as StepRow | undefined;
          if (existing) return toStep(existing);
          // Different step name landed on the same computed step_order — a
          // genuine, retry-safe collision (a fresh GET /steps picks a new order).
          reply.code(409);
          return { error: "step_order collision, retry" };
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
          // Same race as campaign_steps above — resolveRepoId's check-then-insert
          // (mcp.ts) can lose to a concurrent register_pr entry for the same
          // repo. There's no genuine-collision case here (the constraint is
          // exactly "same campaign, same name"), so always hand back the
          // winner's row instead of erroring.
          const existing = db
            .prepare("SELECT * FROM campaign_repos WHERE campaign_id = ? AND github_full_name = ?")
            .get(req.params.campaignId, github_full_name.trim()) as RepoRow;
          return toRepo(existing);
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { campaignId: string; repoId: string }; Body: { pinned?: boolean } }>(
    "/campaigns/:campaignId/repos/:repoId",
    async (req, reply) => {
      if (typeof req.body?.pinned !== "boolean") {
        reply.code(400);
        return { error: "pinned (boolean) is required" };
      }
      const result = db
        .prepare("UPDATE campaign_repos SET pinned = ? WHERE id = ? AND campaign_id = ?")
        .run(req.body.pinned ? 1 : 0, req.params.repoId, req.params.campaignId);
      if (result.changes === 0) {
        reply.code(404);
        return { error: "not found" };
      }
      const row = db.prepare("SELECT * FROM campaign_repos WHERE id = ?").get(req.params.repoId) as RepoRow;
      return toRepo(row);
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
