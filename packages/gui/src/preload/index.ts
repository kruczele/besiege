import { contextBridge, ipcRenderer } from "electron";
import type {
  ActiveClaim,
  AgentAdapter,
  Campaign,
  CampaignStep,
  ConfigRule,
  DaemonHealth,
  DaemonResult,
  Notification,
  PaneNode,
  PrGridRow,
  TaskDefinition,
  TerminalLayout,
  TerminalSession,
} from "../shared/types.js";

export type { DaemonResult };

const api = {
  getDaemonHealth: (): Promise<DaemonResult<DaemonHealth>> => ipcRenderer.invoke("daemon:health"),

  listConfigRules: (): Promise<DaemonResult<ConfigRule[]>> => ipcRenderer.invoke("config:list"),
  createConfigRule: (pattern: string, context: string): Promise<DaemonResult<ConfigRule>> =>
    ipcRenderer.invoke("config:create", pattern, context),
  updateConfigRule: (
    id: number,
    fields: Partial<{ pattern: string; context: string }>,
  ): Promise<DaemonResult<ConfigRule>> => ipcRenderer.invoke("config:update", id, fields),
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
  createCampaign: (
    name: string,
    description: string | undefined,
    defaultDir: string | undefined,
  ): Promise<DaemonResult<Campaign>> => ipcRenderer.invoke("campaigns:create", name, description, defaultDir),
  updateCampaign: (
    id: number,
    fields: Partial<{ name: string; description: string | null; default_dir: string | null }>,
  ): Promise<DaemonResult<Campaign>> => ipcRenderer.invoke("campaigns:update", id, fields),
  deleteCampaign: (id: number): Promise<DaemonResult<void>> => ipcRenderer.invoke("campaigns:delete", id),

  listTasks: (campaignId: number, stepId: number): Promise<DaemonResult<TaskDefinition[]>> =>
    ipcRenderer.invoke("tasks:list", campaignId, stepId),
  createTask: (
    campaignId: number,
    stepId: number,
    name: string,
    context: string,
    since: string,
  ): Promise<DaemonResult<TaskDefinition>> =>
    ipcRenderer.invoke("tasks:create", campaignId, stepId, name, context, since),
  retireTask: (campaignId: number, stepId: number, taskId: number): Promise<DaemonResult<TaskDefinition>> =>
    ipcRenderer.invoke("tasks:retire", campaignId, stepId, taskId),

  releaseClaim: (prId: number): Promise<DaemonResult<void>> => ipcRenderer.invoke("claims:release", prId),

  listTerminals: (campaignId: number): Promise<DaemonResult<TerminalSession[]>> =>
    ipcRenderer.invoke("terminals:list", campaignId),
  createTerminal: (
    campaignId: number,
    cwd: string | undefined,
    label: string | undefined,
    agentAdapterId: number | undefined,
    yolo: boolean | undefined,
    extraArgs: string | undefined,
    resumeFromTerminalId: number | undefined,
  ): Promise<DaemonResult<TerminalSession>> =>
    ipcRenderer.invoke(
      "terminals:create",
      campaignId,
      cwd,
      label,
      agentAdapterId,
      yolo,
      extraArgs,
      resumeFromTerminalId,
    ),
  killTerminal: (id: number): Promise<DaemonResult<{ ok: boolean }>> =>
    ipcRenderer.invoke("terminals:kill", id),
  getTerminalByAgentSession: (agentSessionId: string): Promise<DaemonResult<TerminalSession>> =>
    ipcRenderer.invoke("terminals:byAgentSession", agentSessionId),
  deleteTerminal: (id: number): Promise<DaemonResult<void>> => ipcRenderer.invoke("terminals:delete", id),

  listAgentAdapters: (): Promise<DaemonResult<AgentAdapter[]>> => ipcRenderer.invoke("agents:list"),
  createAgentAdapter: (
    name: string,
    binary: string,
    yoloFlag: string | undefined,
    mcpConfigFlag: string | undefined,
    sessionIdFlag: string | undefined,
    resumeFlag: string | undefined,
  ): Promise<DaemonResult<AgentAdapter>> =>
    ipcRenderer.invoke("agents:create", name, binary, yoloFlag, mcpConfigFlag, sessionIdFlag, resumeFlag),
  updateAgentAdapter: (
    id: number,
    fields: Partial<{
      name: string;
      binary: string;
      yoloFlag: string;
      mcpConfigFlag: string;
      sessionIdFlag: string;
      resumeFlag: string;
    }>,
  ): Promise<DaemonResult<AgentAdapter>> => ipcRenderer.invoke("agents:update", id, fields),
  deleteAgentAdapter: (id: number): Promise<DaemonResult<void>> => ipcRenderer.invoke("agents:delete", id),

  listLayouts: (campaignId: number): Promise<DaemonResult<TerminalLayout[]>> =>
    ipcRenderer.invoke("layouts:list", campaignId),
  createLayout: (campaignId: number, name: string, tree: PaneNode): Promise<DaemonResult<TerminalLayout>> =>
    ipcRenderer.invoke("layouts:create", campaignId, name, tree),
  updateLayout: (
    id: number,
    fields: Partial<{ name: string; isNameCustom: boolean; tree: PaneNode }>,
  ): Promise<DaemonResult<TerminalLayout>> => ipcRenderer.invoke("layouts:update", id, fields),
  deleteLayout: (id: number): Promise<DaemonResult<void>> => ipcRenderer.invoke("layouts:delete", id),

  // Live PTY streaming: openTerminalStream tells main to attach the WS to the
  // daemon (idempotent — safe to call again on remount); attachTerminal wires
  // this renderer up to receive the resulting data/exit events. contextBridge
  // can't pass raw sockets/emitters, so this wraps ipcRenderer.on/removeListener
  // filtered by session id instead of exposing ipcRenderer directly.
  openTerminalStream: (id: number): Promise<void> => ipcRenderer.invoke("terminal:open", id),
  closeTerminalStream: (id: number): Promise<void> => ipcRenderer.invoke("terminal:close", id),
  writeTerminal: (id: number, data: string): Promise<void> => ipcRenderer.invoke("terminal:write", id, data),
  resizeTerminal: (id: number, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke("terminal:resize", id, cols, rows),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("window:close"),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
  zoomIn: (): Promise<void> => ipcRenderer.invoke("window:zoom-in"),
  zoomOut: (): Promise<void> => ipcRenderer.invoke("window:zoom-out"),
  zoomReset: (): Promise<void> => ipcRenderer.invoke("window:zoom-reset"),
  onWindowMaximizeChanged: (onChange: (maximized: boolean) => void): (() => void) => {
    const handler = (_event: unknown, maximized: boolean) => onChange(maximized);
    ipcRenderer.on("window:maximize-changed", handler);
    return () => ipcRenderer.removeListener("window:maximize-changed", handler);
  },

  attachTerminal: (
    id: number,
    onData: (chunk: string) => void,
    onExit: (exitCode: number | null) => void,
  ): (() => void) => {
    const dataHandler = (_event: unknown, msg: { id: number; chunk: string }) => {
      if (msg.id === id) onData(msg.chunk);
    };
    const exitHandler = (_event: unknown, msg: { id: number; exitCode: number | null }) => {
      if (msg.id === id) onExit(msg.exitCode);
    };
    ipcRenderer.on("terminal:data", dataHandler);
    ipcRenderer.on("terminal:exit", exitHandler);
    return () => {
      ipcRenderer.removeListener("terminal:data", dataHandler);
      ipcRenderer.removeListener("terminal:exit", exitHandler);
    };
  },
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
