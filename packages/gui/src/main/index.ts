import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import {
  acknowledgeNotification,
  createCampaign,
  createConfigRule,
  createTerminal,
  deleteCampaign,
  deleteConfigRule,
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
} from "./daemon-client.js";
import * as terminalBridge from "./terminal-bridge.js";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    title: "Besiege",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on("destroyed", () => terminalBridge.detachAll(win.webContents));

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

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
