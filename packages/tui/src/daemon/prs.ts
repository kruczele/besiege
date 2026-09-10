import { callDaemon } from "./client.js";
import type { ActiveClaim, Pr, PrClaim, PrGridRow, PrPendingTask } from "./types.js";

export const fetchCampaignPrs = (campaignId: number, filter?: "needs-me") =>
  callDaemon<PrGridRow[]>("GET", `/campaigns/${campaignId}/prs${filter ? `?filter=${filter}` : ""}`);
export const registerPr = (stepId: number, repoId: number, githubPrNumber?: number, githubNodeId?: string) =>
  callDaemon<Pr>("POST", "/prs", {
    step_id: stepId,
    repo_id: repoId,
    github_pr_number: githubPrNumber,
    github_node_id: githubNodeId,
  });
export const updatePr = (id: number, fields: Partial<Pr>) => callDaemon<Pr>("PATCH", `/prs/${id}`, fields);
export const deletePr = (id: number) => callDaemon<void>("DELETE", `/prs/${id}`);
export const fetchPendingTasks = (prId: number) =>
  callDaemon<PrPendingTask[]>("GET", `/prs/${prId}/pending-tasks`);
export const closePendingTask = (prId: number, taskDefinitionId: number) =>
  callDaemon<{ ok: boolean }>("POST", `/prs/${prId}/pending-tasks/${taskDefinitionId}/close`);
export const triggerCampaignSync = (campaignId: number) =>
  callDaemon<{ queued: boolean }>("POST", `/campaigns/${campaignId}/sync`);
export const triggerPrSync = (prId: number) => callDaemon<{ queued: boolean }>("POST", `/prs/${prId}/sync`);

export const claimPr = (prId: number, agentId: string, sessionId: string, note?: string) =>
  callDaemon<PrClaim>("POST", `/prs/${prId}/claim`, { agent_id: agentId, session_id: sessionId, note });
export const releasePrClaim = (prId: number) => callDaemon<void>("DELETE", `/prs/${prId}/claim`);
export const heartbeatPrClaim = (prId: number) =>
  callDaemon<{ ok: boolean }>("POST", `/prs/${prId}/claim/heartbeat`);
export const fetchCampaignClaims = (campaignId: number) =>
  callDaemon<ActiveClaim[]>("GET", `/campaigns/${campaignId}/claims`);
