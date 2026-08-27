import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import {
  acknowledgeNotification,
  createConfigRule,
  deleteConfigRule,
  fetchCampaignClaims,
  fetchCampaignPrs,
  fetchCampaigns,
  fetchConfigRules,
  fetchDaemonHealth,
  fetchNotifications,
  fetchSteps,
  triggerCampaignSync,
} from "./daemon-client.js";

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

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
