import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { syncPr, syncCampaign } from "../github.js";
import { fetchPrNodeId, getGitHubToken } from "../github.js";

interface PrRow {
  id: number;
  step_id: number | null;
  repo_id: number;
  github_pr_number: number | null;
  github_node_id: string | null;
  lifecycle: string;
  ci_status: string;
  ci_check_name: string | null;
  review_state: string;
  branch_name: string | null;
  synced_at: string | null;
  created_at: string;
}

interface PendingTaskRow {
  id: number;
  pr_id: number;
  task_definition_id: number;
  task_name: string;
  task_context: string;
  closed_at: string | null;
  created_at: string;
}

interface ClaimRow {
  id: number;
  pr_id: number;
  agent_id: string;
  session_id: string;
  note: string | null;
  claimed_at: string;
  heartbeat_at: string;
  released_at: string | null;
}

const toPr = (r: PrRow) => ({
  id: r.id,
  stepId: r.step_id,
  repoId: r.repo_id,
  githubPrNumber: r.github_pr_number,
  githubNodeId: r.github_node_id,
  lifecycle: r.lifecycle,
  ciStatus: r.ci_status,
  ciCheckName: r.ci_check_name,
  reviewState: r.review_state,
  branchName: r.branch_name,
  syncedAt: r.synced_at,
  createdAt: r.created_at,
});

const toClaim = (r: ClaimRow) => ({
  id: r.id,
  prId: r.pr_id,
  agentId: r.agent_id,
  sessionId: r.session_id,
  note: r.note,
  claimedAt: r.claimed_at,
  heartbeatAt: r.heartbeat_at,
  releasedAt: r.released_at,
});

type SyncPrFn = typeof syncPr;
type SyncCampaignFn = typeof syncCampaign;

export function registerPrRoutes(
  app: FastifyInstance,
  db: Database.Database,
  syncPrFn: SyncPrFn | null,
  syncCampaignFn: SyncCampaignFn | null,
) {
  // Grid view: all PRs for a campaign, joined with repo info for display.
  // ?filter=needs-me: unaddressed feedback, failing CI, or approved+mergeable.
  // ?repo=org/repo: narrow to a single repo. All filters are optional and
  // AND together — omitting them all (as the MCP pr_state tool does when
  // `repo` isn't passed) returns every PR registered in the campaign.
  app.get<{
    Params: { campaignId: string };
    Querystring: { filter?: string; repo?: string; reviewState?: string; ciStatus?: string; lifecycle?: string };
  }>("/campaigns/:campaignId/prs", async (req, reply) => {
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
    if (!campaign) {
      reply.code(404);
      return { error: "campaign not found" };
    }

    // repo is optional — omitting it returns every PR registered anywhere in
    // the campaign, which is what the MCP pr_state tool uses for a
    // campaign-wide query instead of looping per repo.
    const clauses: string[] = [];
    const params: unknown[] = [req.params.campaignId];
    if (req.query.filter === "needs-me") {
      clauses.push(`(p.ci_status = 'failing' OR p.review_state = 'changes-requested')`);
    }
    if (req.query.repo) {
      clauses.push(`cr.github_full_name = ?`);
      params.push(req.query.repo);
    }
    if (req.query.reviewState) {
      clauses.push(`p.review_state = ?`);
      params.push(req.query.reviewState);
    }
    if (req.query.ciStatus) {
      clauses.push(`p.ci_status = ?`);
      params.push(req.query.ciStatus);
    }
    if (req.query.lifecycle) {
      clauses.push(`p.lifecycle = ?`);
      params.push(req.query.lifecycle);
    }
    const filterClause = clauses.map((c) => `AND ${c}`).join(" ");

    const rows = db
      .prepare(
        `SELECT p.*,
                cr.github_full_name AS repo_name,
                cs.name AS step_name,
                cs.step_order,
                (SELECT COUNT(*) FROM pr_pending_tasks pt
                 WHERE pt.pr_id = p.id AND pt.closed_at IS NULL) AS pending_tasks_count
         FROM prs p
         JOIN campaign_repos cr ON cr.id = p.repo_id
         LEFT JOIN campaign_steps cs ON cs.id = p.step_id
         WHERE cr.campaign_id = ?
         ${filterClause}
         ORDER BY (cs.step_order IS NULL) ASC, cs.step_order ASC, cr.github_full_name ASC`,
      )
      .all(...params) as (PrRow & {
        repo_name: string;
        step_name: string | null;
        step_order: number | null;
        pending_tasks_count: number;
      })[];

    return rows.map((r) => ({
      ...toPr(r),
      repoName: r.repo_name,
      stepName: r.step_name,
      stepOrder: r.step_order,
      pendingTasksCount: r.pending_tasks_count,
    }));
  });

  // Register or upsert a PR for a (step, repo) slot — step is optional, so a
  // PR can be registered against just a repo with no step association at all.
  app.post<{
    Body: {
      step_id?: number | null;
      repo_id?: number;
      github_pr_number?: number;
      github_node_id?: string;
    };
  }>("/prs", async (req, reply) => {
    const { step_id, repo_id, github_pr_number, github_node_id } = req.body ?? {};
    if (!repo_id) {
      reply.code(400);
      return { error: "repo_id is required" };
    }
    const stepId = step_id ?? null;
    if (stepId !== null) {
      const step = db.prepare("SELECT id FROM campaign_steps WHERE id = ?").get(stepId);
      if (!step) {
        reply.code(404);
        return { error: "step not found" };
      }
    }
    const repo = db.prepare("SELECT id FROM campaign_repos WHERE id = ?").get(repo_id);
    if (!repo) {
      reply.code(404);
      return { error: "repo not found" };
    }

    const now = new Date().toISOString();
    const lifecycle = github_pr_number ? "open" : "not-started";

    db.prepare(
      `INSERT INTO prs (step_id, repo_id, github_pr_number, github_node_id, lifecycle, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(step_id, repo_id) WHERE step_id IS NOT NULL DO UPDATE SET
         github_pr_number = COALESCE(excluded.github_pr_number, github_pr_number),
         github_node_id   = COALESCE(excluded.github_node_id,   github_node_id),
         lifecycle        = CASE WHEN excluded.lifecycle != 'not-started' THEN excluded.lifecycle ELSE lifecycle END
       ON CONFLICT(repo_id) WHERE step_id IS NULL DO UPDATE SET
         github_pr_number = COALESCE(excluded.github_pr_number, github_pr_number),
         github_node_id   = COALESCE(excluded.github_node_id,   github_node_id),
         lifecycle        = CASE WHEN excluded.lifecycle != 'not-started' THEN excluded.lifecycle ELSE lifecycle END`,
    ).run(stepId, repo_id, github_pr_number ?? null, github_node_id ?? null, lifecycle, now);

    let row = db
      .prepare("SELECT * FROM prs WHERE step_id IS ? AND repo_id = ?")
      .get(stepId, repo_id) as PrRow;

    // register_pr only requires a PR number, not a node id — without one,
    // branch_name/CI/review state can never be filled in by syncPr/
    // syncAllActivePrs (both require github_node_id). Resolve it here, once,
    // from the (repo, number) the caller did give us, so a number-only
    // registration still ends up fully synced instead of stuck forever.
    if (row.github_pr_number && !row.github_node_id) {
      const token = getGitHubToken();
      if (token) {
        const repoRow = db
          .prepare("SELECT github_full_name FROM campaign_repos WHERE id = ?")
          .get(row.repo_id) as { github_full_name: string } | undefined;
        if (repoRow) {
          try {
            const resolved = await fetchPrNodeId(repoRow.github_full_name, row.github_pr_number, token);
            if (resolved) {
              db.prepare("UPDATE prs SET github_node_id = ?, branch_name = COALESCE(branch_name, ?) WHERE id = ?").run(
                resolved.nodeId,
                resolved.branchName,
                row.id,
              );
              row = db.prepare("SELECT * FROM prs WHERE id = ?").get(row.id) as PrRow;
              if (syncPrFn) await syncPrFn(db, row.id);
              row = db.prepare("SELECT * FROM prs WHERE id = ?").get(row.id) as PrRow;
            }
          } catch {
            // Best-effort — GitHub unreachable/rate-limited; next registration
            // or manual /prs/:id/sync call will retry.
          }
        }
      }
    }

    reply.code(201);
    return toPr(row);
  });

  // Partial update of PR state fields.
  app.patch<{
    Params: { id: string };
    Body: Partial<{
      lifecycle: string;
      ci_status: string;
      ci_check_name: string | null;
      review_state: string;
      branch_name: string | null;
      github_pr_number: number | null;
      github_node_id: string | null;
    }>;
  }>("/prs/:id", async (req, reply) => {
    const pr = db.prepare("SELECT * FROM prs WHERE id = ?").get(req.params.id) as PrRow | undefined;
    if (!pr) {
      reply.code(404);
      return { error: "not found" };
    }

    const allowed = [
      "lifecycle",
      "ci_status",
      "ci_check_name",
      "review_state",
      "branch_name",
      "github_pr_number",
      "github_node_id",
    ] as const;

    const updates: string[] = [];
    const values: unknown[] = [];

    for (const key of allowed) {
      if (key in (req.body ?? {})) {
        updates.push(`${key} = ?`);
        const val = (req.body as Record<string, unknown>)[key];
        values.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
      }
    }

    if (updates.length === 0) {
      reply.code(400);
      return { error: "no updatable fields provided" };
    }

    values.push(req.params.id);
    db.prepare(`UPDATE prs SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    const updated = db.prepare("SELECT * FROM prs WHERE id = ?").get(req.params.id) as PrRow;
    return toPr(updated);
  });

  // Drops a PR from tracking entirely — e.g. a stale registration, or one an
  // agent registered against the wrong (repo, step) slot. Foreign keys are
  // enforced (db.ts), so children have to go first; there's no cascade since
  // nothing else deletes a PR row today.
  app.delete<{ Params: { id: string } }>("/prs/:id", async (req, reply) => {
    const pr = db.prepare("SELECT id FROM prs WHERE id = ?").get(req.params.id);
    if (!pr) {
      reply.code(404);
      return { error: "not found" };
    }
    db.transaction(() => {
      db.prepare("DELETE FROM pr_pending_tasks WHERE pr_id = ?").run(req.params.id);
      db.prepare("DELETE FROM pr_claims WHERE pr_id = ?").run(req.params.id);
      db.prepare("DELETE FROM prs WHERE id = ?").run(req.params.id);
    })();
    reply.code(204);
  });

  // Pending tasks for a PR, joined with task name and context for the agent.
  app.get<{ Params: { id: string }; Querystring: { includeClosed?: string } }>(
    "/prs/:id/pending-tasks",
    async (req, reply) => {
      const pr = db.prepare("SELECT id FROM prs WHERE id = ?").get(req.params.id);
      if (!pr) {
        reply.code(404);
        return { error: "not found" };
      }
      const includeClosed = req.query.includeClosed === "true";
      const rows = (
        includeClosed
          ? db
              .prepare(
                `SELECT pt.*, td.name AS task_name, td.context AS task_context
                 FROM pr_pending_tasks pt
                 JOIN task_definitions td ON td.id = pt.task_definition_id
                 WHERE pt.pr_id = ?
                 ORDER BY pt.id ASC`,
              )
              .all(req.params.id)
          : db
              .prepare(
                `SELECT pt.*, td.name AS task_name, td.context AS task_context
                 FROM pr_pending_tasks pt
                 JOIN task_definitions td ON td.id = pt.task_definition_id
                 WHERE pt.pr_id = ? AND pt.closed_at IS NULL
                 ORDER BY pt.id ASC`,
              )
              .all(req.params.id)
      ) as PendingTaskRow[];

      return rows.map((r) => ({
        id: r.id,
        prId: r.pr_id,
        taskDefinitionId: r.task_definition_id,
        taskName: r.task_name,
        taskContext: r.task_context,
        closedAt: r.closed_at,
        createdAt: r.created_at,
      }));
    },
  );

  // Mark a pending task as closed (agent reports it was applied).
  app.post<{ Params: { id: string; taskDefinitionId: string } }>(
    "/prs/:id/pending-tasks/:taskDefinitionId/close",
    async (req, reply) => {
      const result = db
        .prepare(
          "UPDATE pr_pending_tasks SET closed_at = ? WHERE pr_id = ? AND task_definition_id = ? AND closed_at IS NULL",
        )
        .run(new Date().toISOString(), req.params.id, req.params.taskDefinitionId);
      if (result.changes === 0) {
        reply.code(404);
        return { error: "pending task not found or already closed" };
      }
      return { ok: true };
    },
  );

  // All open pending tasks across a campaign, optionally filtered by repo.
  // Used by the MCP pending_tasks tool so agents see what work is outstanding.
  app.get<{ Params: { campaignId: string }; Querystring: { repo?: string } }>(
    "/campaigns/:campaignId/pending-tasks",
    async (req, reply) => {
      const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
      if (!campaign) {
        reply.code(404);
        return { error: "campaign not found" };
      }
      const repoClause = req.query.repo ? `AND cr.github_full_name = ?` : "";
      const params: unknown[] = [req.params.campaignId];
      if (req.query.repo) params.push(req.query.repo);

      const rows = db
        .prepare(
          `SELECT pt.id, pt.pr_id, pt.task_definition_id,
                  td.name AS task_name, td.context AS task_context,
                  cs.name AS step_name, cs.step_order,
                  cr.github_full_name AS repo_name
           FROM pr_pending_tasks pt
           JOIN prs p ON p.id = pt.pr_id
           JOIN task_definitions td ON td.id = pt.task_definition_id
           JOIN campaign_steps cs ON cs.id = p.step_id
           JOIN campaign_repos cr ON cr.id = p.repo_id
           WHERE cs.campaign_id = ?
             AND pt.closed_at IS NULL
             ${repoClause}
           ORDER BY cs.step_order ASC, cr.github_full_name ASC, pt.id ASC`,
        )
        .all(...params) as {
          id: number;
          pr_id: number;
          task_definition_id: number;
          task_name: string;
          task_context: string;
          step_name: string;
          step_order: number;
          repo_name: string;
        }[];

      return rows.map((r) => ({
        id: r.id,
        prId: r.pr_id,
        taskDefinitionId: r.task_definition_id,
        taskName: r.task_name,
        taskContext: r.task_context,
        stepName: r.step_name,
        stepOrder: r.step_order,
        repoName: r.repo_name,
      }));
    },
  );

  // Trigger full campaign sync (async — returns 202).
  app.post<{ Params: { campaignId: string } }>("/campaigns/:campaignId/sync", async (req, reply) => {
    if (!syncCampaignFn) {
      reply.code(503);
      return { error: "GitHub sync not available — no token configured" };
    }
    reply.code(202);
    setImmediate(() => syncCampaignFn(db, req.params.campaignId).catch(console.error));
    return { queued: true };
  });

  // Trigger targeted resync of one PR (async — returns 202).
  app.post<{ Params: { id: string } }>("/prs/:id/sync", async (req, reply) => {
    const pr = db.prepare("SELECT * FROM prs WHERE id = ?").get(req.params.id) as PrRow | undefined;
    if (!pr) {
      reply.code(404);
      return { error: "not found" };
    }
    if (!syncPrFn) {
      reply.code(503);
      return { error: "GitHub sync not available — no token configured" };
    }
    reply.code(202);
    setImmediate(() => syncPrFn(db, pr.id).catch(console.error));
    return { queued: true };
  });

  // Claims
  app.post<{ Params: { id: string }; Body: { agent_id?: string; session_id?: string; note?: string } }>(
    "/prs/:id/claim",
    async (req, reply) => {
      const { agent_id, session_id, note } = req.body ?? {};
      if (!agent_id?.trim() || !session_id?.trim()) {
        reply.code(400);
        return { error: "agent_id and session_id are required" };
      }
      const pr = db.prepare("SELECT id FROM prs WHERE id = ?").get(req.params.id);
      if (!pr) {
        reply.code(404);
        return { error: "not found" };
      }

      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          "UPDATE pr_claims SET released_at = ? WHERE pr_id = ? AND released_at IS NULL",
        ).run(now, req.params.id);
        db.prepare(
          "INSERT INTO pr_claims (pr_id, agent_id, session_id, note, claimed_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(req.params.id, agent_id.trim(), session_id.trim(), note?.trim() ?? null, now, now);
      })();

      const row = db
        .prepare(
          "SELECT * FROM pr_claims WHERE pr_id = ? AND released_at IS NULL ORDER BY id DESC LIMIT 1",
        )
        .get(req.params.id) as ClaimRow;
      reply.code(201);
      return toClaim(row);
    },
  );

  app.delete<{ Params: { id: string } }>("/prs/:id/claim", async (req, reply) => {
    const result = db
      .prepare("UPDATE pr_claims SET released_at = ? WHERE pr_id = ? AND released_at IS NULL")
      .run(new Date().toISOString(), req.params.id);
    if (result.changes === 0) {
      reply.code(404);
      return { error: "no active claim" };
    }
    reply.code(204);
  });

  app.post<{ Params: { id: string } }>("/prs/:id/claim/heartbeat", async (req, reply) => {
    const result = db
      .prepare(
        "UPDATE pr_claims SET heartbeat_at = ? WHERE pr_id = ? AND released_at IS NULL",
      )
      .run(new Date().toISOString(), req.params.id);
    if (result.changes === 0) {
      reply.code(404);
      return { error: "no active claim" };
    }
    return { ok: true };
  });

  // Read the active claim on a PR (used by CLI to warn on double-dispatch).
  app.get<{ Params: { id: string } }>("/prs/:id/claim", async (req, reply) => {
    const row = db
      .prepare(
        "SELECT * FROM pr_claims WHERE pr_id = ? AND released_at IS NULL ORDER BY id DESC LIMIT 1",
      )
      .get(req.params.id) as ClaimRow | undefined;
    if (!row) {
      reply.code(404);
      return { error: "no active claim" };
    }
    return toClaim(row);
  });

  // All active claims for a campaign with PR/step/repo context — live board data source.
  app.get<{ Params: { campaignId: string } }>("/campaigns/:campaignId/claims", async (req, reply) => {
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.campaignId);
    if (!campaign) {
      reply.code(404);
      return { error: "campaign not found" };
    }
    const rows = db
      .prepare(
        `SELECT pc.*,
                p.id AS pr_id, p.github_pr_number, p.lifecycle,
                cs.name AS step_name,
                cr.github_full_name AS repo_name
         FROM pr_claims pc
         JOIN prs p ON p.id = pc.pr_id
         JOIN campaign_steps cs ON cs.id = p.step_id
         JOIN campaign_repos cr ON cr.id = p.repo_id
         WHERE cs.campaign_id = ? AND pc.released_at IS NULL
         ORDER BY pc.claimed_at DESC`,
      )
      .all(req.params.campaignId) as (ClaimRow & {
        github_pr_number: number | null;
        lifecycle: string;
        step_name: string;
        repo_name: string;
      })[];

    return rows.map((r) => ({
      ...toClaim(r),
      githubPrNumber: r.github_pr_number,
      lifecycle: r.lifecycle,
      stepName: r.step_name,
      repoName: r.repo_name,
    }));
  });
}
