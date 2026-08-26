import { contextBridge, ipcRenderer } from "electron";
import type { DaemonHealth } from "../main/daemon-client.js";

export type DaemonHealthResult =
  | { ok: true; health: DaemonHealth }
  | { ok: false; error: string };

const api = {
  getDaemonHealth: (): Promise<DaemonHealthResult> => ipcRenderer.invoke("daemon:health"),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
