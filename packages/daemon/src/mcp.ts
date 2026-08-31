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
  const nextOrder = steps.reduce((max, s) => Math.max(max, s.stepOrder), -1) + 1;
  const created = await postJson<CampaignStep>(`/campaigns/${encodeURIComponent(campaign)}/steps`, {
    name: step,
    step_order: nextOrder,
  });
  return created.id;
}

async function resolvePrId(
  campaign: string,
  repo: string,
  step: string,
  githubPrNumber?: number,
  githubNodeId?: string,
): Promise<number> {
  const [repoId, stepId] = await Promise.all([resolveRepoId(campaign, repo), resolveStepId(campaign, step)]);
  // Upsert — idempotent per the UNIQUE(step_id, repo_id) constraint, same as
  // `besiege dispatch` (cli.ts). github_pr_number/github_node_id are
  // COALESCEd server-side, so omitting them here never clobbers a value
  // register_pr already set.
  const pr = await postJson<Pr>("/prs", {
    step_id: stepId,
    repo_id: repoId,
    github_pr_number: githubPrNumber,
    github_node_id: githubNodeId,
  });
  return pr.id;
}

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
      "Get the current state of all PRs for a repo in a campaign (all steps). " +
      "Prefer this over gh/GitHub API for status reads — it uses the cached daemon state and conserves rate limits.",
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
        step: { type: "string", description: "Step name within the campaign" },
        note: { type: "string", description: "Optional short note about what you're doing" },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["repo", "step"],
    },
  },
  {
    name: "release_pr",
    description: "Release your claim on the PR for (repo, step), e.g. once the work is handed off or done.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: 'GitHub full name, e.g. "org/repo"' },
        step: { type: "string", description: "Step name within the campaign" },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["repo", "step"],
    },
  },
  {
    name: "register_pr",
    description:
      "Record GitHub PR numbers (and optionally node ids) for one or many (repo, step) pairs once they've " +
      "actually been opened, e.g. right after a batch of `gh pr create` runs across a campaign's repos. Takes " +
      "a list so one call covers however many PRs you have, instead of one call per PR. This is what lets the " +
      "campaign board show real PR state (CI, review, lifecycle) instead of 'not started' — without it, the " +
      "daemon has no way to know a PR exists.",
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
              step: { type: "string", description: "Step name within the campaign" },
              githubPrNumber: { type: "number", description: "The PR number from GitHub, e.g. 42" },
              githubNodeId: { type: "string", description: "Optional GitHub GraphQL node id, if you have it" },
            },
            required: ["repo", "step", "githubPrNumber"],
          },
        },
        campaign: CAMPAIGN_PROPERTY,
      },
      required: ["entries"],
    },
  },
  {
    name: "pin_repo",
    description:
      "Pin a repo in the campaign for one-click access from the GUI (a quick-open bar linking straight to " +
      "its GitHub page). Use this for repos that matter most to keep an eye on in a campaign spanning many " +
      "repos — e.g. the one with the actual behavior change, versus repos only touched for a mechanical bump.",
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
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, string>;

  try {
    switch (name) {
      case "pr_state": {
        const { repo } = a;
        const campaign = resolveCampaign(a);
        if (!repo) throw new Error("repo is required");
        const data = await getJson(
          `/campaigns/${encodeURIComponent(campaign)}/prs?repo=${encodeURIComponent(repo)}`,
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
        if (!repo || !step) throw new Error("repo and step are required");
        const prId = await resolvePrId(campaign, repo, step);
        await postJson(`/prs/${prId}/claim`, {
          agent_id: `mcp:${SESSION_ID}`,
          session_id: SESSION_ID,
          note,
        });
        claimedPrIds.add(prId);
        return { content: [{ type: "text", text: `Claimed PR ${prId} (${repo}, step ${step}).` }] };
      }

      case "release_pr": {
        const { repo, step } = a;
        const campaign = resolveCampaign(a);
        if (!repo || !step) throw new Error("repo and step are required");
        const prId = await resolvePrId(campaign, repo, step);
        await deleteJson(`/prs/${prId}/claim`);
        claimedPrIds.delete(prId);
        return { content: [{ type: "text", text: `Released claim on PR ${prId} (${repo}, step ${step}).` }] };
      }

      case "register_pr": {
        const campaign = resolveCampaign(a);
        const entries = (args as { entries?: unknown[] } | undefined)?.entries;
        if (!Array.isArray(entries) || entries.length === 0) {
          throw new Error("entries (a non-empty array) is required");
        }
        const outcomes = await Promise.allSettled(
          entries.map(async (raw) => {
            const entry = raw as { repo?: string; step?: string; githubPrNumber?: number; githubNodeId?: string };
            if (!entry.repo || !entry.step || !entry.githubPrNumber) {
              throw new Error(`invalid entry: ${JSON.stringify(raw)}`);
            }
            const prId = await resolvePrId(campaign, entry.repo, entry.step, entry.githubPrNumber, entry.githubNodeId);
            return `${entry.repo} (${entry.step}) -> PR #${entry.githubPrNumber}, pr id ${prId}`;
          }),
        );
        const lines = outcomes.map((o, i) =>
          o.status === "fulfilled"
            ? `ok: ${o.value}`
            : `failed (entry ${i}): ${o.reason instanceof Error ? o.reason.message : String(o.reason)}`,
        );
        const allFailed = outcomes.length > 0 && outcomes.every((o) => o.status === "rejected");
        return { content: [{ type: "text", text: lines.join("\n") }], isError: allFailed };
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
