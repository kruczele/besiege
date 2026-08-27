import { contextBridge, ipcRenderer } from "electron";
import type {
  ActiveClaim,
  Campaign,
  CampaignStep,
  ConfigRule,
  DaemonHealth,
  DaemonResult,
  Notification,
  PrGridRow,
} from "../shared/types.js";

export type { DaemonResult };

const api = {
  getDaemonHealth: (): Promise<DaemonResult<DaemonHealth>> => ipcRenderer.invoke("daemon:health"),

  listConfigRules: (): Promise<DaemonResult<ConfigRule[]>> => ipcRenderer.invoke("config:list"),
  createConfigRule: (pattern: string, context: string): Promise<DaemonResult<ConfigRule>> =>
    ipcRenderer.invoke("config:create", pattern, context),
  deleteConfigRule: (id: number): Promise<DaemonResult<void>> =>
    ipcRenderer.invoke("config:delete", id),

  listNotifications: (unacknowledgedOnly: boolean): Promise<DaemonResult<Notification[]>> =>
    ipcRenderer.invoke("notifications:list", unacknowledgedOnly),
  acknowledgeNotification: (id: number): Promise<DaemonResult<Notification>> =>
    ipcRenderer.invoke("notifications:ack", id),

  listCampaigns: (): Promise<DaemonResult<Campaign[]>> => ipcRenderer.invoke("campaigns:list"),
  listSteps: (campaignId: number): Promise<DaemonResult<CampaignStep[]>> =>
    ipcRenderer.invoke("campaigns:steps", campaignId),
  listCampaignPrs: (campaignId: number, needsMe: boolean): Promise<DaemonResult<PrGridRow[]>> =>
    ipcRenderer.invoke("campaigns:prs", campaignId, needsMe),
  listCampaignClaims: (campaignId: number): Promise<DaemonResult<ActiveClaim[]>> =>
    ipcRenderer.invoke("campaigns:claims", campaignId),
  syncCampaign: (campaignId: number): Promise<DaemonResult<{ queued: boolean }>> =>
    ipcRenderer.invoke("campaigns:sync", campaignId),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
