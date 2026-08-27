import { request } from "node:http";
import { socketPath } from "./daemon-paths.js";
import type {
  ActiveClaim,
  Campaign,
  CampaignRepo,
  CampaignStep,
  ConfigRule,
  DaemonHealth,
  FailureSignature,
  Notification,
  Pr,
  PrClaim,
  PrGridRow,
  PrPendingTask,
  TaskDefinition,
} from "../shared/types.js";

export type {
  ActiveClaim,
  Campaign,
  CampaignRepo,
  CampaignStep,
  ConfigRule,
  DaemonHealth,
  FailureSignature,
  Notification,
  Pr,
  PrClaim,
  PrGridRow,
  PrPendingTask,
  TaskDefinition,
};

function callDaemon<T>(method: "GET" | "POST" | "DELETE" | "PATCH", path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method,
        timeout: 2000,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 300) {
            reject(new Error(`daemon responded with ${res.statusCode}`));
            return;
          }
          try {
            resolve(data ? (JSON.parse(data) as T) : (undefined as T));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("daemon request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

export const fetchDaemonHealth = () => callDaemon<DaemonHealth>("GET", "/health");

export const fetchConfigRules = () => callDaemon<ConfigRule[]>("GET", "/config/rules");

export const createConfigRule = (pattern: string, context: string) =>
  callDaemon<ConfigRule>("POST", "/config/rules", { pattern, context });

export const deleteConfigRule = (id: number) => callDaemon<void>("DELETE", `/config/rules/${id}`);

export const fetchNotifications = (unacknowledgedOnly: boolean) =>
  callDaemon<Notification[]>(
    "GET",
    `/notifications${unacknowledgedOnly ? "?unacknowledged=true" : ""}`,
  );

export const acknowledgeNotification = (id: number) =>
  callDaemon<Notification>("POST", `/notifications/${id}/ack`);

// Campaigns
export const fetchCampaigns = () => callDaemon<Campaign[]>("GET", "/campaigns");
export const createCampaign = (name: string, description?: string) =>
  callDaemon<Campaign>("POST", "/campaigns", { name, description });
export const deleteCampaign = (id: number) => callDaemon<void>("DELETE", `/campaigns/${id}`);

// Steps
export const fetchSteps = (campaignId: number) =>
  callDaemon<CampaignStep[]>("GET", `/campaigns/${campaignId}/steps`);
export const createStep = (campaignId: number, name: string, stepOrder: number) =>
  callDaemon<CampaignStep>("POST", `/campaigns/${campaignId}/steps`, { name, step_order: stepOrder });
export const deleteStep = (campaignId: number, stepId: number) =>
  callDaemon<void>("DELETE", `/campaigns/${campaignId}/steps/${stepId}`);

// Repos
export const fetchRepos = (campaignId: number) =>
  callDaemon<CampaignRepo[]>("GET", `/campaigns/${campaignId}/repos`);
export const createRepo = (campaignId: number, githubFullName: string) =>
  callDaemon<CampaignRepo>("POST", `/campaigns/${campaignId}/repos`, { github_full_name: githubFullName });
export const deleteRepo = (campaignId: number, repoId: number) =>
  callDaemon<void>("DELETE", `/campaigns/${campaignId}/repos/${repoId}`);

// Task definitions
export const fetchTasks = (campaignId: number, stepId: number) =>
  callDaemon<TaskDefinition[]>("GET", `/campaigns/${campaignId}/steps/${stepId}/tasks`);
export const createTask = (
  campaignId: number,
  stepId: number,
  name: string,
  context: string,
  since: string,
) =>
  callDaemon<TaskDefinition>("POST", `/campaigns/${campaignId}/steps/${stepId}/tasks`, {
    name,
    context,
    since,
  });
export const retireTask = (campaignId: number, stepId: number, taskId: number) =>
  callDaemon<TaskDefinition>(
    "POST",
    `/campaigns/${campaignId}/steps/${stepId}/tasks/${taskId}/retire`,
  );

// PRs
export const fetchCampaignPrs = (campaignId: number, filter?: "needs-me") =>
  callDaemon<PrGridRow[]>(
    "GET",
    `/campaigns/${campaignId}/prs${filter ? `?filter=${filter}` : ""}`,
  );
export const registerPr = (
  stepId: number,
  repoId: number,
  githubPrNumber?: number,
  githubNodeId?: string,
) =>
  callDaemon<Pr>("POST", "/prs", {
    step_id: stepId,
    repo_id: repoId,
    github_pr_number: githubPrNumber,
    github_node_id: githubNodeId,
  });
export const updatePr = (id: number, fields: Partial<Pr>) =>
  callDaemon<Pr>("PATCH", `/prs/${id}`, fields);
export const fetchPendingTasks = (prId: number) =>
  callDaemon<PrPendingTask[]>("GET", `/prs/${prId}/pending-tasks`);
export const closePendingTask = (prId: number, taskDefinitionId: number) =>
  callDaemon<{ ok: boolean }>("POST", `/prs/${prId}/pending-tasks/${taskDefinitionId}/close`);
export const triggerCampaignSync = (campaignId: number) =>
  callDaemon<{ queued: boolean }>("POST", `/campaigns/${campaignId}/sync`);
export const triggerPrSync = (prId: number) =>
  callDaemon<{ queued: boolean }>("POST", `/prs/${prId}/sync`);

// Claims
export const claimPr = (prId: number, agentId: string, sessionId: string, note?: string) =>
  callDaemon<PrClaim>("POST", `/prs/${prId}/claim`, { agent_id: agentId, session_id: sessionId, note });
export const releasePrClaim = (prId: number) => callDaemon<void>("DELETE", `/prs/${prId}/claim`);
export const heartbeatPrClaim = (prId: number) =>
  callDaemon<{ ok: boolean }>("POST", `/prs/${prId}/claim/heartbeat`);

export const fetchCampaignClaims = (campaignId: number) =>
  callDaemon<ActiveClaim[]>("GET", `/campaigns/${campaignId}/claims`);

// Failure signatures
export const fetchFailures = (campaignId: number) =>
  callDaemon<FailureSignature[]>("GET", `/campaigns/${campaignId}/failures`);
export const lookupFailure = (campaignId: number, signature: string) =>
  callDaemon<FailureSignature | null>(
    "GET",
    `/campaigns/${campaignId}/failures?signature=${encodeURIComponent(signature)}`,
  );
export const upsertFailure = (campaignId: number, signature: string, fixContext: string) =>
  callDaemon<FailureSignature>("POST", `/campaigns/${campaignId}/failures`, {
    signature,
    fix_context: fixContext,
  });
export const deleteFailure = (campaignId: number, id: number) =>
  callDaemon<void>("DELETE", `/campaigns/${campaignId}/failures/${id}`);
