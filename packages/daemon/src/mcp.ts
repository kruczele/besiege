// MCP server entry point (separate binary from index.ts/daemon).
// Exposes 3 read-only tools so agents can query campaign state without
// hitting GitHub's API directly — rate-limit conservation at fleet scale.
// Configured per-session via .claude/settings.json mcpServers block;
// the besiege CLI wrapper (future) will inject this automatically.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getJson } from "./hooks/client.js";
import { socketPath } from "./paths.js";

const server = new Server(
  { name: "besiege", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "pr_state",
    description:
      "Get the current state of all PRs for a repo in a campaign (all steps). " +
      "Prefer this over gh/GitHub API for status reads — it uses the cached daemon state and conserves rate limits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: 'GitHub full name, e.g. "org/repo"',
        },
        campaign: {
          type: "string",
          description: "Campaign ID (integer as string)",
        },
      },
      required: ["repo", "campaign"],
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
        repo: {
          type: "string",
          description: 'GitHub full name, e.g. "org/repo"',
        },
        campaign: {
          type: "string",
          description: "Campaign ID (integer as string)",
        },
      },
      required: ["repo", "campaign"],
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
        campaign: {
          type: "string",
          description: "Campaign ID (integer as string)",
        },
      },
      required: ["signature", "campaign"],
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
        const { repo, campaign } = a;
        if (!repo || !campaign) throw new Error("repo and campaign are required");
        const data = await getJson(
          `/campaigns/${encodeURIComponent(campaign)}/prs?repo=${encodeURIComponent(repo)}`,
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "pending_tasks": {
        const { repo, campaign } = a;
        if (!repo || !campaign) throw new Error("repo and campaign are required");
        const data = await getJson(
          `/campaigns/${encodeURIComponent(campaign)}/pending-tasks?repo=${encodeURIComponent(repo)}`,
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "failure_pattern": {
        const { signature, campaign } = a;
        if (!signature || !campaign) throw new Error("signature and campaign are required");
        const data = await getJson(
          `/campaigns/${encodeURIComponent(campaign)}/failures?signature=${encodeURIComponent(signature)}`,
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
