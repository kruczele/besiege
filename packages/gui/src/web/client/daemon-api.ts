// Browser-side mirror of ../../main/daemon-client.ts — same exported
// functions/signatures, but calling the web server's /api proxy over fetch
// instead of the daemon's Unix socket directly over node:http.
import type {
  ActiveClaim,
  AgentAdapter,
  Campaign,
  CampaignStep,
  ConfigRule,
  DaemonHealth,
  Notification,
  PaneNode,
  PrGridRow,
  TaskDefinition,
  TerminalLayout,
  TerminalSession,
} from "../../shared/types.js";

async function callDaemon<T>(method: "GET" | "POST" | "DELETE" | "PATCH", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`daemon responded with ${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const fetchDaemonHealth = () => callDaemon<DaemonHealth>("GET", "/health");

export const fetchConfigRules = () => callDaemon<ConfigRule[]>("GET", "/config/rules");
export const createConfigRule = (pattern: string, context: string) =>
  callDaemon<ConfigRule>("POST", "/config/rules", { pattern, context });
export const updateConfigRule = (id: number, fields: Partial<{ pattern: string; context: string }>) =>
  callDaemon<ConfigRule>("PATCH", `/config/rules/${id}`, fields);
export const deleteConfigRule = (id: number) => callDaemon<void>("DELETE", `/config/rules/${id}`);

export const fetchNotifications = (unacknowledgedOnly: boolean) =>
  callDaemon<Notification[]>("GET", `/notifications${unacknowledgedOnly ? "?unacknowledged=true" : ""}`);
export const acknowledgeNotification = (id: number) =>
  callDaemon<Notification>("POST", `/notifications/${id}/ack`);

export const fetchCampaigns = () => callDaemon<Campaign[]>("GET", "/campaigns");
export const createCampaign = (name: string, description?: string, defaultDir?: string) =>
  callDaemon<Campaign>("POST", "/campaigns", { name, description, default_dir: defaultDir });
export const updateCampaign = (
  id: number,
  fields: Partial<{ name: string; description: string | null; default_dir: string | null }>,
) => callDaemon<Campaign>("PATCH", `/campaigns/${id}`, fields);
export const deleteCampaign = (id: number) => callDaemon<void>("DELETE", `/campaigns/${id}`);

export const fetchSteps = (campaignId: number) =>
  callDaemon<CampaignStep[]>("GET", `/campaigns/${campaignId}/steps`);

export const fetchTasks = (campaignId: number, stepId: number) =>
  callDaemon<TaskDefinition[]>("GET", `/campaigns/${campaignId}/steps/${stepId}/tasks`);
export const createTask = (campaignId: number, stepId: number, name: string, context: string) =>
  callDaemon<TaskDefinition>("POST", `/campaigns/${campaignId}/steps/${stepId}/tasks`, { name, context });
export const retireTask = (campaignId: number, stepId: number, taskId: number) =>
  callDaemon<TaskDefinition>("POST", `/campaigns/${campaignId}/steps/${stepId}/tasks/${taskId}/retire`);

export const fetchCampaignPrs = (campaignId: number, filter?: "needs-me") =>
  callDaemon<PrGridRow[]>("GET", `/campaigns/${campaignId}/prs${filter ? `?filter=${filter}` : ""}`);
export const triggerCampaignSync = (campaignId: number) =>
  callDaemon<{ queued: boolean }>("POST", `/campaigns/${campaignId}/sync`);

export const releasePrClaim = (prId: number) => callDaemon<void>("DELETE", `/prs/${prId}/claim`);
export const fetchCampaignClaims = (campaignId: number) =>
  callDaemon<ActiveClaim[]>("GET", `/campaigns/${campaignId}/claims`);

export const listTerminals = (campaignId: number) =>
  callDaemon<TerminalSession[]>("GET", `/campaigns/${campaignId}/terminals`);
export const createTerminal = (
  campaignId: number,
  cwd?: string,
  label?: string,
  agentAdapterName?: string,
  yolo?: boolean,
  extraArgs?: string,
  resumeFromTerminalId?: number,
) =>
  callDaemon<TerminalSession>("POST", `/campaigns/${campaignId}/terminals`, {
    cwd,
    label,
    agentAdapterName,
    yolo,
    extraArgs,
    resumeFromTerminalId,
  });
export const killTerminal = (id: number) => callDaemon<{ ok: boolean }>("POST", `/terminals/${id}/kill`);
export const getTerminalByAgentSession = (agentSessionId: string) =>
  callDaemon<TerminalSession>("GET", `/terminal-sessions/by-agent-session/${encodeURIComponent(agentSessionId)}`);
export const deleteTerminal = (id: number) => callDaemon<void>("DELETE", `/terminals/${id}`);

export const fetchAgentAdapters = () => callDaemon<AgentAdapter[]>("GET", "/agents");

export const fetchLayouts = (campaignId: number) =>
  callDaemon<TerminalLayout[]>("GET", `/campaigns/${campaignId}/layouts`);
export const createLayout = (campaignId: number, name: string, tree: PaneNode) =>
  callDaemon<TerminalLayout>("POST", `/campaigns/${campaignId}/layouts`, { name, tree });
export const updateLayout = (id: number, fields: Partial<{ name: string; isNameCustom: boolean; tree: PaneNode }>) =>
  callDaemon<TerminalLayout>("PATCH", `/layouts/${id}`, fields);
export const deleteLayout = (id: number) => callDaemon<void>("DELETE", `/layouts/${id}`);
