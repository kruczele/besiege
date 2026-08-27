import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import { join } from "node:path";
import {
  acknowledgeNotification,
  createCampaign,
  createConfigRule,
  createTerminal,
  deleteCampaign,
  deleteConfigRule,
  deleteTerminal,
  fetchCampaignClaims,
  fetchCampaignPrs,
  fetchCampaigns,
  fetchConfigRules,
  fetchDaemonHealth,
  fetchNotifications,
  fetchSteps,
  killTerminal,
  listTerminals,
  triggerCampaignSync,
  updateCampaign,
  updateConfigRule,
} from "./daemon-client.js";
import * as terminalBridge from "./terminal-bridge.js";

const icon = nativeImage.createFromPath(join(__dirname, "../../resources/icon.png"));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    title: "Besiege",
    icon,
    frame: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on("destroyed", () => terminalBridge.detachAll(win.webContents));
  win.on("maximize", () => win.webContents.send("window:maximize-changed", true));
  win.on("unmaximize", () => win.webContents.send("window:maximize-changed", false));

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
daemonHandle("config:create", (pattern: string, context: string) => createConfigRule(pattern, context));
daemonHandle("config:update", (id: number, fields: Record<string, unknown>) => updateConfigRule(id, fields));
daemonHandle("config:delete", (id: number) => deleteConfigRule(id));
daemonHandle("notifications:list", (unacknowledgedOnly: boolean) =>
  fetchNotifications(unacknowledgedOnly),
);
daemonHandle("notifications:ack", (id: number) => acknowledgeNotification(id));
daemonHandle("campaigns:list", fetchCampaigns);
daemonHandle("campaigns:steps", (campaignId: number) => fetchSteps(campaignId));
daemonHandle("campaigns:prs", (campaignId: number, needsMe: boolean) =>
  fetchCampaignPrs(campaignId, needsMe ? "needs-me" : undefined),
);
daemonHandle("campaigns:claims", (campaignId: number) => fetchCampaignClaims(campaignId));
daemonHandle("campaigns:sync", (campaignId: number) => triggerCampaignSync(campaignId));
daemonHandle("campaigns:create", (name: string, description: string | undefined, defaultDir: string | undefined) =>
  createCampaign(name, description, defaultDir),
);
daemonHandle("campaigns:update", (id: number, fields: Record<string, unknown>) => updateCampaign(id, fields));
daemonHandle("campaigns:delete", (id: number) => deleteCampaign(id));

ipcMain.handle("dialog:pick-directory", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

daemonHandle("terminals:list", (campaignId: number) => listTerminals(campaignId));
daemonHandle("terminals:create", (campaignId: number, cwd: string | undefined, label: string | undefined) =>
  createTerminal(campaignId, cwd, label),
);
daemonHandle("terminals:kill", (id: number) => killTerminal(id));
daemonHandle("terminals:delete", (id: number) => deleteTerminal(id));

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
