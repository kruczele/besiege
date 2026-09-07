// Agent adapters are a hand-edited YAML config, not a database table — the
// flags for third-party CLIs are easy to get wrong or for the CLI to change,
// and a config file the user can fix in an editor beats a CRUD UI/API for
// that. agents.default.yaml ships with Besiege (checked in); agents.local.yaml
// is gitignored and joined on top of it by name, so a user's own additions
// or overrides never conflict with an upstream update to the defaults.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface AgentConfig {
  name: string;
  binary: string;
  yoloFlag?: string;
  mcpConfigFlag?: string;
  sessionIdFlag?: string;
  resumeFlag?: string;
  // For CLIs with no per-launch --mcp-config-style flag (e.g. agy, where
  // MCP servers are a persistent named registry) — an argv template run
  // once before spawn to (idempotently) register Besiege's MCP server,
  // instead of pointing the launch itself at a config file. {execPath} and
  // {mcpEntryPoint} get substituted, same spirit as {path}/{sessionId}
  // elsewhere. See ensureMcpRegistered in terminals.ts.
  mcpRegisterCommand?: string;
  // For CLIs with no way to pre-assign/learn a conversation id at launch
  // (e.g. agy) — path to a JSON file (map of absolute cwd -> conversation
  // id) that gets a fresh entry shortly after an interactive session
  // starts, polled post-spawn to discover the id for resumeFlag. See
  // terminals.ts. "~" is expanded the same way cwd is.
  sessionIdFromWorkspaceCache?: string;
}

// Same anchor logic as terminals.ts's MCP_ENTRY_POINT: this module runs as
// either dist/agent-config.js (prod) or src/agent-config.ts (dev, tsx watch),
// so one directory up from wherever it happens to live is the stable way to
// reach the package root either way.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PATH = join(PACKAGE_ROOT, "agents.default.yaml");
const LOCAL_PATH = join(PACKAGE_ROOT, "agents.local.yaml");

function loadYamlList(path: string): AgentConfig[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? (parsed as AgentConfig[]) : [];
}

// Re-read on every call rather than cached once — these are hand-edited
// files a user expects to take effect on the next launch without a daemon
// restart, and reading two small YAML files is cheap.
export function loadAgentConfigs(): AgentConfig[] {
  const byName = new Map<string, AgentConfig>();
  for (const entry of loadYamlList(DEFAULT_PATH)) byName.set(entry.name, entry);
  for (const entry of loadYamlList(LOCAL_PATH)) byName.set(entry.name, entry);
  return [...byName.values()];
}

export function findAgentConfig(name: string): AgentConfig | undefined {
  return loadAgentConfigs().find((a) => a.name === name);
}
