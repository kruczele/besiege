// MCP server entry point (separate binary from index.ts/daemon).
// Exposes read tools so agents can query campaign state without hitting
// GitHub's API directly (rate-limit conservation at fleet scale), plus write
// tools so an agent can self-claim a PR, register a task, and raise a
// notification — closing the loop for sessions launched from a GUI pane,
// which (unlike `besiege dispatch`) never claim anything on their own.
// Configured per-session via each agent_adapter's mcp_config_flag
// (terminals.ts) or, for `besiege dispatch`, the CLI's own --mcp-config flag.
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { deleteJson, getJson, patchJson, postJson } from "./hooks/client.js";
import { socketPath } from "./paths.js";

const server = new Server(
  { name: "besiege", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// Besiege-launched sessions (GUI pane launch or `besiege dispatch`) set
// these — see terminals.ts spawnSession / cli.ts dispatch — so most calls
// don't need to pass `campaign` explicitly. A bare MCP server run outside
// either launch path (e.g. manual testing) still requires it as an argument.
const ENV_CAMPAIGN_ID = process.env.BESIEGE_CAMPAIGN_ID;
// Identifies this session to claims/notifications. Falls back to a fresh id
// for the rare case this process was started without Besiege's own env vars.
const SESSION_ID = process.env.BESIEGE_SESSION_ID ?? randomUUID();

function resolveCampaign(a: Record<string, string>): string {
  const campaign = a.campaign ?? ENV_CAMPAIGN_ID;
  if (!campaign) {
    throw new Error(
      "campaign is required (no BESIEGE_CAMPAIGN_ID in the environment to default from)",
    );
  }
  return campaign;
}

interface CampaignRepo {
  id: number;
  githubFullName: string;
}

interface CampaignStep {
  id: number;
  name: string;
  stepOrder: number;
}

interface Pr {
  id: number;
}

// Repos register themselves into the campaign the first time a PR touches
// them — requiring a human to pre-register every repo before an agent can
// report a PR defeats the point of a campaign spanning however many repos
// turn out to need one, especially at the "hundreds of repos" end.
async function resolveRepoId(campaign: string, repo: string): Promise<number> {
  const repos = await getJson<CampaignRepo[]>(
    `/campaigns/${encodeURIComponent(campaign)}/repos?name=${encodeURIComponent(repo)}`,
  );
  if (repos.length > 0) return repos[0].id;
  const created = await postJson<CampaignRepo>(`/campaigns/${encodeURIComponent(campaign)}/repos`, {
    github_full_name: repo,
  });
  return created.id;
}

// Steps register themselves the first time an agent references them by name
// — same reasoning as resolveRepoId above: requiring a human to pre-create
// every step (there was previously no UI or tool to do so at all) before an
// agent can claim or register a PR against it defeats the point of an agent
// driving a campaign end-to-end from a plain description of the work.
async function resolveStepId(campaign: string, step: string): Promise<number> {
  const steps = await getJson<CampaignStep[]>(`/campaigns/${encodeURIComponent(campaign)}/steps`);
  const match = steps.find((s) => s.name.toLowerCase() === step.toLowerCase());
  if (match) return match.id;
  // step_order is left for the server to compute atomically (routes/campaigns.ts)
  // rather than derived from `steps` here — concurrent register_pr entries
  // creating different-named steps in the same batch would otherwise all
  // compute the same "next" order from this same GET and race each other's
  // insert.
  const created = await postJson<CampaignStep>(`/campaigns/${encodeURIComponent(campaign)}/steps`, {
    name: step,
  });
  return created.id;
}

async function resolvePrId(
  campaign: string,
  repo: string,
  step: string | undefined,
  githubPrNumber?: number,
  githubNodeId?: string,
  // POST /prs backfills github_node_id from a live GitHub call when only a PR
  // number is given (see prs.ts) — register_pr hits that path and needs more
  // than the 2s default the daemon socket otherwise uses for everything else.
  timeoutMs?: number,
): Promise<number> {
  const repoId = await resolveRepoId(campaign, repo);
  const stepId = step ? await resolveStepId(campaign, step) : null;
  // Upsert — idempotent per (repo_id, github_pr_number) once a PR number is
  // known, same as `besiege dispatch` (cli.ts); step_id is an updatable
  // field on that row, not part of its identity, so registering the same PR
  // under a different step moves it instead of forking a duplicate. Without
  // a number yet, (repo_id, step_id) is used instead (see routes/prs.ts).
  // github_pr_number/github_node_id are COALESCEd server-side, so omitting
  // them here never clobbers a value register_pr already set.
  const pr = await postJson<Pr>(
    "/prs",
    {
      step_id: stepId,
      repo_id: repoId,
      github_pr_number: githubPrNumber,
      github_node_id: githubNodeId,
    },
    timeoutMs,
  );
  return pr.id;
}

// Looks up a PR by (repo, githubPrNumber) without auto-creating anything —
// unlike resolvePrId, unregister_pr has nothing useful to do with a repo or
// PR that doesn't already exist, so it should report "nothing to remove"
// rather than create one just to immediately delete it.
async function findPrId(campaign: string, repo: string, githubPrNumber: number): Promise<number | null> {
  const repos = await getJson<CampaignRepo[]>(
    `/campaigns/${encodeURIComponent(campaign)}/repos?name=${encodeURIComponent(repo)}`,
  );
  if (repos.length === 0) return null;
  const prs = await getJson<{ id: number; githubPrNumber: number | null }[]>(
    `/campaigns/${encodeURIComponent(campaign)}/prs?repo=${encodeURIComponent(repo)}`,
  );
  const match = prs.find((p) => p.githubPrNumber === githubPrNumber);
  return match ? match.id : null;
}

// Bounded-concurrency map — register_pr entries used to all fire at once via
// Promise.all, which under a large batch (e.g. 40+ repos sharing one step)
// piled up concurrent daemon requests and GitHub API calls faster than either
// could keep up, cascading into client-side timeouts. Chunking here means
// callers no longer need to split large batches themselves.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (let i = next++; i < items.length; i = next++) {
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const REGISTER_PR_CONCURRENCY = 8;
const REGISTER_PR_TIMEOUT_MS = 10_000;

// PRs this MCP server process has claimed — heartbeated below for as long as
// the process (i.e. the agent's session) is alive, and best-effort released
// on exit, so a self-claim behaves like `besiege dispatch`'s claim without
// requiring the agent to remember to heartbeat or release itself.
const claimedPrIds = new Set<number>();

setInterval(() => {
  for (const id of claimedPrIds) {
    postJson(`/prs/${id}/claim/heartbeat`, {}).catch(() => {
      // Best-effort — daemon might be temporarily unreachable.
    });
  }
}, 30_000);

async function releaseAllClaims(): Promise<void> {
  await Promise.all(
    [...claimedPrIds].map((id) =>
      deleteJson(`/prs/${id}/claim`).catch(() => {
        // Already expired or released — not an error.
      }),
    ),
  );
  claimedPrIds.clear();
}

const CAMPAIGN_PROPERTY = {
  type: "string" as const,
  description:
    "Campaign ID (integer as string). Optional inside a Besiege-launched session — defaults to BESIEGE_CAMPAIGN_ID.",
};

const TOOLS = [
  {
    name: "pr_state",
    description:
      "Get the current state of PRs in a campaign. Pass repo to scope to one repo (all its steps); omit it " +
      "to get every PR registered anywhere in the campaign in a single call — use this for campaign-wide " +
      "triage (e.g. \"which of my PRs have changes requested\") instead of looping pr_state per repo. " +
      "Optionally narrow further with reviewState/ciStatus/lifecycle. " +
      "Prefer this over gh/GitHub API for status reads — it uses the cached daemon state and conserves rate limits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: 'GitHub full name, e.g. "org/repo". Omit for every repo in the campaign.' },
        reviewState: { type: "string", description: 'Optional exact-match filter, e.g. "changes-requested", "approved".' },
        ciStatus: { type: "string", description: 'Optional exact-match filter, e.g. "failing", "passing", "pending".' },
        lifecycle: { type: "string", description: 'Optional exact-match filter, e.g. "open", "merged", "not-started".' },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: [],
    },
  },
  {
    name: "pending_tasks",
    description:
      "List all open pending tasks for a repo in a campaign. " +
      "Each entry includes step name, task name, and the task context (instructions to apply). " +
      "Bundle these alongside the primary work whenever touching a PR.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: 'GitHub full name, e.g. "org/repo"' },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["repo"],
    },
  },
  {
    name: "failure_pattern",
    description:
      "Look up a known failure signature to get the documented fix. " +
      "Call this when a CI check fails before attempting to diagnose from scratch — " +
      "the fix may already be documented from a prior session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        signature: {
          type: "string",
          description:
            'Failure identifier — the CI check name, lint rule, or short error key. E.g. "eslint-no-unused-vars"',
        },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["signature"],
    },
  },
  {
    name: "claim_pr",
    description:
      "Claim the PR for (repo, step) in a campaign as the agent working on it, so it shows up as an " +
      "active agent on the campaign's Live board. Claiming is advisory: it force-releases any existing " +
      "claim rather than failing, so check pr_state first if you want to avoid stepping on another agent. " +
      "The claim is kept alive automatically (heartbeated) for as long as this session runs — call " +
      "release_pr when you're done, or just let the session end and it will expire on its own.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: 'GitHub full name, e.g. "org/repo"' },
        step: {
          type: "string",
          description:
            "Step name within the campaign. Optional, same as register_pr — omit it for a single-feature " +
            "task with no real pipeline stage rather than inventing a step name just to have one.",
        },
        note: { type: "string", description: "Optional short note about what you're doing" },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["repo"],
    },
  },
  {
    name: "release_pr",
    description: "Release your claim on the PR for (repo, step), e.g. once the work is handed off or done.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: 'GitHub full name, e.g. "org/repo"' },
        step: { type: "string", description: "Step name within the campaign. Optional — omit if claim_pr was called with no step." },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["repo"],
    },
  },
  {
    name: "register_pr",
    description:
      "Record GitHub PR numbers (and optionally node ids) for one or many (repo, step) pairs once they've " +
      "actually been opened, e.g. right after a batch of `gh pr create` runs across a campaign's repos. Takes " +
      "a list so one call covers however many PRs you have, instead of one call per PR — entries are " +
      `processed with bounded concurrency (${REGISTER_PR_CONCURRENCY} at a time) internally, so there's no ` +
      "need to pre-split a large batch yourself. This is what lets the campaign board show real PR state " +
      "(CI, review, lifecycle) instead of 'not started' — without it, the daemon has no way to know a PR " +
      "exists. This never pins the repo — pinning is a separate, human-requested action (see pin_repo); " +
      "don't call pin_repo alongside this unless explicitly asked to.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entries: {
          type: "array",
          description: "One entry per PR to register",
          items: {
            type: "object",
            properties: {
              repo: { type: "string", description: 'GitHub full name, e.g. "org/repo"' },
              step: {
                type: "string",
                description:
                  "Step name within the campaign. Optional — omit to register the PR with no step association.",
              },
              githubPrNumber: { type: "number", description: "The PR number from GitHub, e.g. 42" },
              githubNodeId: { type: "string", description: "Optional GitHub GraphQL node id, if you have it" },
            },
            required: ["repo", "githubPrNumber"],
          },
        },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["entries"],
    },
  },
  {
    name: "unregister_pr",
    description:
      "Remove a single PR record for (repo, githubPrNumber) from tracking entirely — e.g. a stray " +
      "registration left under the wrong step, or a placeholder claim_pr created that never got a real PR. " +
      "This is a hard delete: the PR's pending tasks and any active claim go with it. It's a no-op (not an " +
      "error) if no matching record exists, so it's safe to retry. Not for the normal merged/closed case — " +
      "that's a lifecycle change on an existing record, not a removal.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: 'GitHub full name, e.g. "org/repo"' },
        githubPrNumber: { type: "number", description: "The PR number from GitHub, e.g. 42" },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["repo", "githubPrNumber"],
    },
  },
  {
    name: "delete_step",
    description:
      "Permanently remove a step from the campaign's pipeline. This cascades: any PRs still registered " +
      "under the step (and their pending tasks/claims) and any task definitions for it are deleted along with " +
      "it, not just checked for emptiness. Use it to clean up a step created by mistake, or one whose PRs " +
      "have all since been moved to a different step via register_pr. It's a no-op (not an error) if no step " +
      "by that name exists, so it's safe to retry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        step: { type: "string", description: "Step name within the campaign" },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["step"],
    },
  },
  {
    name: "pin_repo",
    description:
      "Pin a repo in the campaign for one-click access from the GUI (a quick-open bar linking straight to " +
      "its GitHub page). Only call this when a human explicitly asks you to pin (or unpin) a specific repo — " +
      "never as a side effect of register_pr or claim_pr, and never on your own judgment about which repos " +
      "seem more important. A campaign can span hundreds of repos; pinning is a human curation choice for the " +
      "one or two worth watching closely, not something to apply per-PR or per-repo automatically.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: 'GitHub full name, e.g. "org/repo"' },
        pinned: { type: "boolean", description: "true to pin (default), false to unpin" },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["repo"],
    },
  },
  {
    name: "create_step",
    description:
      "Declare a step in the campaign's pipeline (e.g. \"Bump dependency\", \"Verify\", \"Cleanup\"), so PRs " +
      "and tasks can be registered against it. Idempotent by name — calling this again for a step that " +
      "already exists just returns it, so it's safe to call up front for every step of a plan without " +
      "checking first. New steps are appended after the last existing one; claim_pr/register_pr/create_task " +
      "also auto-create a step by this same name the first time you reference it, so this is only needed " +
      "when you want the full pipeline to show up on the campaign board before any PR exists.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Step name" },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["name"],
    },
  },
  {
    name: "create_task",
    description:
      "Register a new task definition for a step — instructions that should be applied to every PR in " +
      "that step, effective immediately. Every existing PR in the step automatically gets it added as a " +
      "pending task; a PR opened after this call should already reflect it via the primary work.",
    inputSchema: {
      type: "object" as const,
      properties: {
        step: { type: "string", description: "Step name within the campaign" },
        name: { type: "string", description: "Short task name" },
        context: { type: "string", description: "Full instructions for applying this task" },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["step", "name", "context"],
    },
  },
  {
    name: "notify",
    description:
      "Push a message into the operator's attention inbox — use this when you're blocked, waiting on " +
      "input, or have a question that needs a human before you can continue.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "The question or message for the operator" },
      },
      required: ["message"],
    },
  },
  {
    name: "pin_note",
    description:
      "Pin text to a new panel in the GUI grid, opened directly below the pane running this session — " +
      "use when the user asks to pin, keep on screen, or save something (e.g. a summary) so it stops " +
      "scrolling away as the conversation continues. Only works when this session is running in a " +
      "Besiege GUI pane (not a headless besiege dispatch run).",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: 'Short panel title, e.g. "PR failure summary". Defaults to "Pinned".',
        },
        content: { type: "string", description: "The text to pin, shown as-is (plain text, not rendered)." },
      },
      required: ["content"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, string>;

  try {
    switch (name) {
      case "pr_state": {
        const { repo, reviewState, ciStatus, lifecycle } = a;
        const campaign = resolveCampaign(a);
        const qs = new URLSearchParams();
        if (repo) qs.set("repo", repo);
        if (reviewState) qs.set("reviewState", reviewState);
        if (ciStatus) qs.set("ciStatus", ciStatus);
        if (lifecycle) qs.set("lifecycle", lifecycle);
        const query = qs.toString();
        const data = await getJson(
          `/campaigns/${encodeURIComponent(campaign)}/prs${query ? `?${query}` : ""}`,
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "pending_tasks": {
        const { repo } = a;
        const campaign = resolveCampaign(a);
        if (!repo) throw new Error("repo is required");
        const data = await getJson(
          `/campaigns/${encodeURIComponent(campaign)}/pending-tasks?repo=${encodeURIComponent(repo)}`,
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "failure_pattern": {
        const { signature } = a;
        const campaign = resolveCampaign(a);
        if (!signature) throw new Error("signature is required");
        const data = await getJson(
          `/campaigns/${encodeURIComponent(campaign)}/failures?signature=${encodeURIComponent(signature)}`,
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "claim_pr": {
        const { repo, step, note } = a;
        const campaign = resolveCampaign(a);
        if (!repo) throw new Error("repo is required");
        const prId = await resolvePrId(campaign, repo, step || undefined);
        await postJson(`/prs/${prId}/claim`, {
          agent_id: `mcp:${SESSION_ID}`,
          session_id: SESSION_ID,
          note,
        });
        claimedPrIds.add(prId);
        return {
          content: [{ type: "text", text: `Claimed PR ${prId} (${repo}${step ? `, step ${step}` : ""}).` }],
        };
      }

      case "release_pr": {
        const { repo, step } = a;
        const campaign = resolveCampaign(a);
        if (!repo) throw new Error("repo is required");
        const prId = await resolvePrId(campaign, repo, step || undefined);
        await deleteJson(`/prs/${prId}/claim`);
        claimedPrIds.delete(prId);
        return {
          content: [{ type: "text", text: `Released claim on PR ${prId} (${repo}${step ? `, step ${step}` : ""}).` }],
        };
      }

      case "register_pr": {
        const campaign = resolveCampaign(a);
        const entries = (args as { entries?: unknown[] } | undefined)?.entries;
        if (!Array.isArray(entries) || entries.length === 0) {
          throw new Error("entries (a non-empty array) is required");
        }
        const outcomes = await mapWithConcurrency(entries, REGISTER_PR_CONCURRENCY, async (raw) => {
          const entry = raw as { repo?: string; step?: string; githubPrNumber?: number; githubNodeId?: string };
          if (!entry.repo || !entry.githubPrNumber) {
            throw new Error(`invalid entry: ${JSON.stringify(raw)}`);
          }
          const prId = await resolvePrId(
            campaign,
            entry.repo,
            entry.step,
            entry.githubPrNumber,
            entry.githubNodeId,
            REGISTER_PR_TIMEOUT_MS,
          );
          return `${entry.repo}${entry.step ? ` (${entry.step})` : ""} -> PR #${entry.githubPrNumber}, pr id ${prId}`;
        });
        const lines = outcomes.map((o, i) =>
          o.status === "fulfilled"
            ? `ok: ${o.value}`
            : `failed (entry ${i}): ${o.reason instanceof Error ? o.reason.message : String(o.reason)}`,
        );
        const allFailed = outcomes.length > 0 && outcomes.every((o) => o.status === "rejected");
        return { content: [{ type: "text", text: lines.join("\n") }], isError: allFailed };
      }

      case "unregister_pr": {
        const campaign = resolveCampaign(a);
        const { repo, githubPrNumber } = (args ?? {}) as { repo?: string; githubPrNumber?: number };
        if (!repo || !githubPrNumber) throw new Error("repo and githubPrNumber are required");
        const prId = await findPrId(campaign, repo, githubPrNumber);
        if (prId === null) {
          return { content: [{ type: "text", text: `No PR record found for ${repo} #${githubPrNumber} — nothing to remove.` }] };
        }
        await deleteJson(`/prs/${prId}`);
        return { content: [{ type: "text", text: `Removed PR record for ${repo} #${githubPrNumber} (pr id ${prId}).` }] };
      }

      case "delete_step": {
        const campaign = resolveCampaign(a);
        const { step } = a;
        if (!step) throw new Error("step is required");
        const steps = await getJson<CampaignStep[]>(`/campaigns/${encodeURIComponent(campaign)}/steps`);
        const match = steps.find((s) => s.name.toLowerCase() === step.toLowerCase());
        if (!match) {
          return { content: [{ type: "text", text: `No step named '${step}' found — nothing to delete.` }] };
        }
        await deleteJson(`/campaigns/${encodeURIComponent(campaign)}/steps/${match.id}`);
        return { content: [{ type: "text", text: `Deleted step '${step}' (and any PRs/tasks under it).` }] };
      }

      case "pin_repo": {
        const campaign = resolveCampaign(a);
        const { repo, pinned } = (args ?? {}) as { repo?: string; pinned?: boolean };
        if (!repo) throw new Error("repo is required");
        const repoId = await resolveRepoId(campaign, repo);
        await patchJson(`/campaigns/${encodeURIComponent(campaign)}/repos/${repoId}`, {
          pinned: pinned ?? true,
        });
        return {
          content: [{ type: "text", text: `${repo} is now ${pinned === false ? "unpinned" : "pinned"}.` }],
        };
      }

      case "create_step": {
        const { name: stepName } = a;
        const campaign = resolveCampaign(a);
        if (!stepName) throw new Error("name is required");
        const stepId = await resolveStepId(campaign, stepName);
        return { content: [{ type: "text", text: `Step '${stepName}' is registered (id ${stepId}).` }] };
      }

      case "create_task": {
        const { step, name: taskName, context } = a;
        const campaign = resolveCampaign(a);
        if (!step || !taskName || !context) {
          throw new Error("step, name, and context are all required");
        }
        const stepId = await resolveStepId(campaign, step);
        const data = await postJson(`/campaigns/${encodeURIComponent(campaign)}/steps/${stepId}/tasks`, {
          name: taskName,
          context,
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "notify": {
        const { message } = a;
        if (!message) throw new Error("message is required");
        await postJson("/notifications", { sessionId: SESSION_ID, cwd: process.cwd(), message });
        return { content: [{ type: "text", text: "Notification sent." }] };
      }

      case "pin_note": {
        const { title, content } = a;
        if (!content) throw new Error("content is required");
        await postJson("/pin-note", { sessionId: SESSION_ID, title, content });
        return { content: [{ type: "text", text: "Pinned to a new panel below this pane." }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function shutdown() {
  await releaseAllClaims();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function main() {
  process.stderr.write(`besiege MCP server starting — daemon socket: ${socketPath}\n`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("besiege MCP server ready\n");
}

main().catch((err) => {
  process.stderr.write(`besiege MCP fatal: ${err}\n`);
  process.exit(1);
});
