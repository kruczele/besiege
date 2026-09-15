import { spawnSync } from "node:child_process";
import type Database from "better-sqlite3";

interface PrRow {
  id: number;
  github_node_id: string;
}

interface PrRowPartial {
  id: number;
  github_pr_number: number | null;
  github_node_id: string | null;
  repo_full_name: string;
}

interface GitHubPrState {
  lifecycle: string;
  ciStatus: string;
  ciCheckName: string | null;
  reviewState: string;
  branchName: string | null;
}

// Maps GitHub PR state to our lifecycle enum.
function mapState(state: string, isDraft: boolean, merged: boolean): string {
  if (merged) return "merged";
  if (state === "CLOSED") return "closed";
  if (isDraft) return "open";
  return "open";
}

// Maps GitHub's aggregate review decision (accounts for required reviewers
// and dismissed reviews, unlike a single `reviews(last: 1)` node) to our
// review_state. REVIEW_REQUIRED and null (no reviews requested at all) are
// both "missing" — the board only needs to know whether a human has to look.
function mapReview(reviewDecision: string | null): string {
  if (reviewDecision === "APPROVED") return "approved";
  if (reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  return "missing";
}

// Maps GitHub CI rollup state to our ci_status. PENDING/EXPECTED (checks
// queued or not yet reported) both count as "running" rather than
// "unknown" — "unknown" is reserved for a PR with no CI configured at all
// (null rollup), which the board treats the same as "running" (not
// confirmed safe) but is worth keeping distinct in the data itself.
function mapCi(rollupState: string | null, contexts: { name: string; conclusion: string | null }[]): {
  ciStatus: string;
  ciCheckName: string | null;
} {
  if (!rollupState) return { ciStatus: "unknown", ciCheckName: null };
  if (rollupState === "SUCCESS") return { ciStatus: "passing", ciCheckName: null };
  if (rollupState === "PENDING" || rollupState === "EXPECTED") return { ciStatus: "running", ciCheckName: null };
  const failed = contexts.find((c) => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT");
  return { ciStatus: "failing", ciCheckName: failed?.name ?? null };
}

function buildBatchQuery(nodeIds: string[]): string {
  const aliases = nodeIds
    .map(
      (id, i) => `
    pr${i}: node(id: "${id}") {
      ... on PullRequest {
        state
        isDraft
        merged
        reviewDecision
        headRefName
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 20) {
                  nodes {
                    ... on CheckRun { name conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    )
    .join("\n");
  return `{ ${aliases} }`;
}

async function graphqlBatch(
  nodeIds: string[],
  token: string,
): Promise<Map<string, GitHubPrState>> {
  const BATCH_SIZE = 100;
  const result = new Map<string, GitHubPrState>();

  for (let i = 0; i < nodeIds.length; i += BATCH_SIZE) {
    const batch = nodeIds.slice(i, i + BATCH_SIZE);
    const query = buildBatchQuery(batch);

    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "besiege-daemon",
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      throw new Error(`GitHub GraphQL responded ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { data: Record<string, unknown>; errors?: unknown[] };
    if (json.errors?.length) {
      console.warn("GitHub GraphQL partial errors:", json.errors);
    }

    batch.forEach((nodeId, j) => {
      const pr = json.data?.[`pr${j}`] as {
        state: string;
        isDraft: boolean;
        merged: boolean;
        reviewDecision: string | null;
        headRefName: string;
        commits: {
          nodes: {
            commit: {
              statusCheckRollup: {
                state: string;
                contexts: { nodes: { name?: string; context?: string; conclusion?: string | null; state?: string }[] };
              } | null;
            };
          }[];
        };
      } | null;

      if (!pr) return;

      const lifecycle = mapState(pr.state, pr.isDraft, pr.merged);
      const reviewState = mapReview(pr.reviewDecision);
      const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
      const contexts = (rollup?.contexts?.nodes ?? []).map((n) => ({
        name: n.name ?? n.context ?? "unknown",
        conclusion: n.conclusion ?? (n.state === "FAILURE" ? "FAILURE" : null),
      }));
      const { ciStatus, ciCheckName } = mapCi(rollup?.state ?? null, contexts);

      result.set(nodeId, { lifecycle, ciStatus, ciCheckName, reviewState, branchName: pr.headRefName ?? null });
    });
  }

  return result;
}

export function getGitHubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  try {
    const result = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const token = result.stdout?.trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated — skip
  }

  return null;
}

// A one-off REST lookup (not the batched GraphQL path above) for the case
// where an agent registered a PR by number only, with no node id — there's
// nothing to batch, and this is the only way to *get* a node id from just a
// repo + PR number. Also grabs head.ref for free so branch_name has a value
// immediately, without waiting on the next syncPr/syncAllActivePrs pass.
export async function fetchPrNodeId(
  repoFullName: string,
  prNumber: number,
  token: string,
): Promise<{ nodeId: string; branchName: string | null } | null> {
  const res = await fetch(`https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`, {
    headers: {
      Authorization: `bearer ${token}`,
      "User-Agent": "besiege-daemon",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) return null;

  const json = (await res.json()) as { node_id?: string; head?: { ref?: string } };
  if (!json.node_id) return null;
  return { nodeId: json.node_id, branchName: json.head?.ref ?? null };
}

export async function syncPr(db: Database.Database, prId: number): Promise<void> {
  const token = getGitHubToken();
  if (!token) return;

  const pr = db
    .prepare("SELECT id, github_node_id FROM prs WHERE id = ? AND github_node_id IS NOT NULL")
    .get(prId) as PrRow | undefined;
  if (!pr) return;

  const states = await graphqlBatch([pr.github_node_id], token);
  const state = states.get(pr.github_node_id);
  if (!state) return;

  db.prepare(
    `UPDATE prs SET lifecycle = ?, ci_status = ?, ci_check_name = ?,
     review_state = ?, branch_name = ?, synced_at = ?
     WHERE id = ?`,
  ).run(
    state.lifecycle,
    state.ciStatus,
    state.ciCheckName,
    state.reviewState,
    state.branchName,
    new Date().toISOString(),
    pr.id,
  );
}

export async function syncCampaign(db: Database.Database, campaignId: string | number): Promise<void> {
  const token = getGitHubToken();
  if (!token) return;

  // Resolve node IDs for any PRs that are still missing one (e.g. registered
  // by number only and fetchPrNodeId failed at registration time).
  const unresolved = db
    .prepare(
      `SELECT p.id, p.github_pr_number, p.github_node_id, cr.github_full_name AS repo_full_name
       FROM prs p
       JOIN campaign_steps cs ON cs.id = p.step_id
       JOIN campaign_repos cr ON cr.id = p.repo_id
       WHERE cs.campaign_id = ?
         AND p.github_pr_number IS NOT NULL
         AND p.github_node_id IS NULL
         AND p.lifecycle NOT IN ('merged', 'closed')`,
    )
    .all(campaignId) as PrRowPartial[];

  for (const pr of unresolved) {
    try {
      const resolved = await fetchPrNodeId(pr.repo_full_name, pr.github_pr_number!, token);
      if (resolved) {
        db.prepare("UPDATE prs SET github_node_id = ?, branch_name = COALESCE(branch_name, ?) WHERE id = ?").run(
          resolved.nodeId,
          resolved.branchName,
          pr.id,
        );
      }
    } catch {
      // Best-effort — skip this PR for now, will retry on next sync.
    }
  }

  const prs = db
    .prepare(
      `SELECT p.id, p.github_node_id
       FROM prs p
       JOIN campaign_steps cs ON cs.id = p.step_id
       WHERE cs.campaign_id = ?
         AND p.github_node_id IS NOT NULL
         AND p.lifecycle NOT IN ('merged', 'closed')`,
    )
    .all(campaignId) as PrRow[];

  if (prs.length === 0) return;

  const nodeIds = prs.map((p) => p.github_node_id);
  const states = await graphqlBatch(nodeIds, token);

  const update = db.prepare(
    `UPDATE prs SET lifecycle = ?, ci_status = ?, ci_check_name = ?,
     review_state = ?, branch_name = ?, synced_at = ?
     WHERE id = ?`,
  );

  db.transaction(() => {
    for (const pr of prs) {
      const state = states.get(pr.github_node_id);
      if (!state) continue;
      update.run(
        state.lifecycle,
        state.ciStatus,
        state.ciCheckName,
        state.reviewState,
        state.branchName,
        new Date().toISOString(),
        pr.id,
      );
    }
  })();
}

// A PR that's fully green (CI passing, review approved) is as "done" as it
// gets short of merging — polling it as often as one that's failing or
// waiting on a re-review just burns rate limit. Anything not confirmed safe
// (failing, running, changes-requested, or simply never synced) gets the
// short interval instead.
const SAFE_RESYNC_MS = 30 * 60 * 1000;
const WATCH_RESYNC_MS = 2 * 60 * 1000;

export async function syncAllActivePrs(db: Database.Database): Promise<void> {
  const token = getGitHubToken();
  if (!token) return;

  const safeCutoff = new Date(Date.now() - SAFE_RESYNC_MS).toISOString();
  const watchCutoff = new Date(Date.now() - WATCH_RESYNC_MS).toISOString();

  const prs = db
    .prepare(
      `SELECT id, github_node_id FROM prs
       WHERE github_node_id IS NOT NULL
         AND lifecycle NOT IN ('merged', 'closed')
         AND (
           synced_at IS NULL
           OR (ci_status = 'passing' AND review_state = 'approved' AND synced_at < ?)
           OR (NOT (ci_status = 'passing' AND review_state = 'approved') AND synced_at < ?)
         )`,
    )
    .all(safeCutoff, watchCutoff) as PrRow[];

  if (prs.length === 0) return;

  const nodeIds = prs.map((p) => p.github_node_id);
  const states = await graphqlBatch(nodeIds, token);

  const update = db.prepare(
    `UPDATE prs SET lifecycle = ?, ci_status = ?, ci_check_name = ?,
     review_state = ?, branch_name = ?, synced_at = ?
     WHERE id = ?`,
  );

  db.transaction(() => {
    for (const pr of prs) {
      const state = states.get(pr.github_node_id);
      if (!state) continue;
      update.run(
        state.lifecycle,
        state.ciStatus,
        state.ciCheckName,
        state.reviewState,
        state.branchName,
        new Date().toISOString(),
        pr.id,
      );
    }
  })();
}

export function expireStaleClaims(db: Database.Database): void {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE pr_claims SET released_at = ? WHERE released_at IS NULL AND heartbeat_at < ?",
  ).run(new Date().toISOString(), fiveMinutesAgo);
}
