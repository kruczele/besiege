import { app, BrowserWindow, ipcMain, nativeImage, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acknowledgeNotification,
  archiveCampaign,
  unarchiveCampaign,
  createCampaign,
  createConfigRule,
  createLayout,
  createTerminal,
  deleteCampaign,
  deleteConfigRule,
  deleteLayout,
  deleteTerminal,
  fetchAgentAdapters,
  fetchCampaignClaims,
  deletePr,
  fetchCampaignPrs,
  fetchCampaigns,
  fetchConfigRules,
  fetchDaemonHealth,
  createTask,
  fetchLayouts,
  fetchNotifications,
  fetchRepos,
  fetchSteps,
  fetchTasks,
  getTerminalByAgentSession,
  killTerminal,
  listTerminals,
  releasePrClaim,
  retireTask,
  setRepoPinned,
  triggerCampaignSync,
  updateCampaign,
  updateConfigRule,
  updateLayout,
  updateTask,
  deleteTask,
} from "./daemon-client.js";
import * as terminalBridge from "./terminal-bridge.js";
import type { PaneNode } from "../shared/types.js";

const icon = nativeImage.createFromPath(join(__dirname, "../../resources/icon.png"));

// Small persisted window state — remembered across launches so the window
// doesn't reopen at the small Electron default every time. Not daemon state
// (it's per-machine display layout, not campaign data), so a flat JSON file
// under Electron's own userData dir is simpler than a DB round trip.
interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
  zoomLevel: number;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 1440, height: 900, maximized: false, zoomLevel: 0 };
const ZOOM_MIN = -4;
const ZOOM_MAX = 6;

function windowStatePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(windowStatePath(), "utf-8");
    return { ...DEFAULT_WINDOW_STATE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
}

function saveWindowState(win: BrowserWindow): void {
  const bounds = win.getBounds();
  const state: WindowState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: win.isMaximized(),
    zoomLevel: win.webContents.zoomLevel,
  };
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(windowStatePath(), JSON.stringify(state));
  } catch {
    // Best-effort — losing remembered window state isn't worth surfacing.
  }
}

function createWindow(): void {
  const saved = loadWindowState();

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    title: "Besiege",
    icon,
    frame: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setZoomLevel(saved.zoomLevel);
  if (saved.maximized) win.maximize();

  // PR board links (target="_blank") would otherwise spawn a bare in-app
  // Chromium window — route them to the OS browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("destroyed", () => terminalBridge.detachAll(win.webContents));
  win.on("maximize", () => win.webContents.send("window:maximize-changed", true));
  win.on("unmaximize", () => win.webContents.send("window:maximize-changed", false));
  win.on("resize", () => saveWindowState(win));
  win.on("move", () => saveWindowState(win));
  win.on("close", () => saveWindowState(win));

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// Wraps a daemon call so IPC never rejects — the renderer always gets
// { ok, ... } and decides how to render a down/unreachable daemon.
function daemonHandle<T>(channel: string, fn: (...args: any[]) => Promise<T>) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true as const, result: await fn(...args) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });
}

daemonHandle("daemon:health", fetchDaemonHealth);
daemonHandle("config:list", fetchConfigRules);
daemonHandle("config:create", (pattern: string, context: string, besiegeOnly?: boolean) =>
  createConfigRule(pattern, context, besiegeOnly),
);
daemonHandle("config:update", (id: number, fields: Record<string, unknown>) => updateConfigRule(id, fields));
daemonHandle("config:delete", (id: number) => deleteConfigRule(id));
daemonHandle("notifications:list", (unacknowledgedOnly: boolean) =>
  fetchNotifications(unacknowledgedOnly),
);
daemonHandle("notifications:ack", (id: number) => acknowledgeNotification(id));
daemonHandle("campaigns:list", (includeArchived?: boolean) => fetchCampaigns(includeArchived));
daemonHandle("campaigns:steps", (campaignId: number) => fetchSteps(campaignId));
daemonHandle("campaigns:prs", (campaignId: number, needsMe: boolean) =>
  fetchCampaignPrs(campaignId, needsMe ? "needs-me" : undefined),
);
daemonHandle("prs:delete", (id: number) => deletePr(id));
daemonHandle("campaigns:claims", (campaignId: number) => fetchCampaignClaims(campaignId));
daemonHandle("campaigns:repos", (campaignId: number) => fetchRepos(campaignId));
daemonHandle("campaigns:repos:pin", (campaignId: number, repoId: number, pinned: boolean) =>
  setRepoPinned(campaignId, repoId, pinned),
);
daemonHandle("campaigns:sync", (campaignId: number) => triggerCampaignSync(campaignId));
daemonHandle("campaigns:create", (name: string, description: string | undefined, defaultDir: string | undefined) =>
  createCampaign(name, description, defaultDir),
);
daemonHandle("campaigns:update", (id: number, fields: Record<string, unknown>) => updateCampaign(id, fields));
daemonHandle("campaigns:archive", (id: number) => archiveCampaign(id));
daemonHandle("campaigns:unarchive", (id: number) => unarchiveCampaign(id));
daemonHandle("campaigns:delete", (id: number) => deleteCampaign(id));

daemonHandle("tasks:list", (campaignId: number, stepId: number) => fetchTasks(campaignId, stepId));
daemonHandle("tasks:create", (campaignId: number, stepId: number, name: string, context: string) =>
  createTask(campaignId, stepId, name, context),
);
daemonHandle("tasks:retire", (campaignId: number, stepId: number, taskId: number) =>
  retireTask(campaignId, stepId, taskId),
);
daemonHandle(
  "tasks:update",
  (campaignId: number, stepId: number, taskId: number, fields: Record<string, unknown>) =>
    updateTask(campaignId, stepId, taskId, fields),
);
daemonHandle("tasks:delete", (campaignId: number, stepId: number, taskId: number) =>
  deleteTask(campaignId, stepId, taskId),
);

daemonHandle("claims:release", (prId: number) => releasePrClaim(prId));

daemonHandle("terminals:list", (campaignId: number) => listTerminals(campaignId));
daemonHandle(
  "terminals:create",
  (
    campaignId: number,
    cwd: string | undefined,
    label: string | undefined,
    agentAdapterName: string | undefined,
    yolo: boolean | undefined,
    extraArgs: string | undefined,
    resumeFromTerminalId: number | undefined,
  ) => createTerminal(campaignId, cwd, label, agentAdapterName, yolo, extraArgs, resumeFromTerminalId),
);
daemonHandle("terminals:kill", (id: number) => killTerminal(id));
daemonHandle("terminals:byAgentSession", (agentSessionId: string) => getTerminalByAgentSession(agentSessionId));
daemonHandle("terminals:delete", (id: number) => deleteTerminal(id));

daemonHandle("agents:list", fetchAgentAdapters);

daemonHandle("layouts:list", (campaignId: number) => fetchLayouts(campaignId));
daemonHandle("layouts:create", (campaignId: number, name: string, tree: PaneNode) =>
  createLayout(campaignId, name, tree),
);
daemonHandle("layouts:update", (id: number, fields: Record<string, unknown>) => updateLayout(id, fields));
daemonHandle("layouts:delete", (id: number) => deleteLayout(id));

ipcMain.handle("terminal:open", (event, id: number) => {
  terminalBridge.attach(event.sender, id);
});
ipcMain.handle("terminal:close", (event, id: number) => {
  terminalBridge.detach(event.sender, id);
});
ipcMain.handle("terminal:write", (_event, id: number, data: string) => {
  terminalBridge.write(id, data);
});
ipcMain.handle("terminal:resize", (_event, id: number, cols: number, rows: number) => {
  terminalBridge.resize(id, cols, rows);
});

ipcMain.handle("shell:open-external", (_event, url: string) => {
  void shell.openExternal(url);
});

ipcMain.handle("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.handle("window:toggle-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle("window:is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

// No application menu (frame: false, no visible menu bar) to hang zoom
// accelerators off, so the renderer listens for Ctrl/Cmd +/- itself and
// calls these instead.
ipcMain.handle("window:zoom-in", (event) => {
  const wc = event.sender;
  wc.setZoomLevel(Math.min(ZOOM_MAX, wc.zoomLevel + 0.5));
});
ipcMain.handle("window:zoom-out", (event) => {
  const wc = event.sender;
  wc.setZoomLevel(Math.max(ZOOM_MIN, wc.zoomLevel - 0.5));
});
ipcMain.handle("window:zoom-reset", (event) => {
  event.sender.setZoomLevel(0);
});

app.whenReady().then(() => {
  // BrowserWindow's `icon` option is ignored on macOS — the dock icon is
  // set separately.
  if (process.platform === "darwin") app.dock?.setIcon(icon);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
