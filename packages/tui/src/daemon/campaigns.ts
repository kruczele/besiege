import { callDaemon } from "./client.js";
import type { Campaign, CampaignRepo, CampaignStep } from "./types.js";

export const fetchCampaigns = (includeArchived?: boolean) =>
  callDaemon<Campaign[]>("GET", `/campaigns${includeArchived ? "?includeArchived=1" : ""}`);
export const createCampaign = (name: string, description?: string, defaultDir?: string) =>
  callDaemon<Campaign>("POST", "/campaigns", { name, description, default_dir: defaultDir });
export const updateCampaign = (
  id: number,
  fields: Partial<{ name: string; description: string | null; default_dir: string | null }>,
) => callDaemon<Campaign>("PATCH", `/campaigns/${id}`, fields);
export const archiveCampaign = (id: number) => callDaemon<Campaign>("POST", `/campaigns/${id}/archive`);
export const unarchiveCampaign = (id: number) => callDaemon<Campaign>("POST", `/campaigns/${id}/unarchive`);
export const deleteCampaign = (id: number) => callDaemon<void>("DELETE", `/campaigns/${id}`);

export const fetchSteps = (campaignId: number) =>
  callDaemon<CampaignStep[]>("GET", `/campaigns/${campaignId}/steps`);
export const createStep = (campaignId: number, name: string, stepOrder: number) =>
  callDaemon<CampaignStep>("POST", `/campaigns/${campaignId}/steps`, { name, step_order: stepOrder });
export const deleteStep = (campaignId: number, stepId: number) =>
  callDaemon<void>("DELETE", `/campaigns/${campaignId}/steps/${stepId}`);

export const fetchRepos = (campaignId: number) =>
  callDaemon<CampaignRepo[]>("GET", `/campaigns/${campaignId}/repos`);
export const createRepo = (campaignId: number, githubFullName: string) =>
  callDaemon<CampaignRepo>("POST", `/campaigns/${campaignId}/repos`, { github_full_name: githubFullName });
export const deleteRepo = (campaignId: number, repoId: number) =>
  callDaemon<void>("DELETE", `/campaigns/${campaignId}/repos/${repoId}`);
export const setRepoPinned = (campaignId: number, repoId: number, pinned: boolean) =>
  callDaemon<CampaignRepo>("PATCH", `/campaigns/${campaignId}/repos/${repoId}`, { pinned });
