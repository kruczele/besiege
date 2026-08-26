import { contextBridge, ipcRenderer } from "electron";
import type { ConfigRule, DaemonHealth, DaemonResult, Notification } from "../shared/types.js";

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
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
