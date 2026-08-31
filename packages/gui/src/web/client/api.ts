// Browser-side mirror of ../../preload/index.ts's `api` object — assembled
// from daemon-api.ts (fetch-based) plus a plain WebSocket per terminal id
// (no Electron IPC indirection needed: one browser tab, not multiple
// isolated renderer webContents to multiplex across).
import type { Api } from "../../preload/index.js";
import type { DaemonResult } from "../../shared/types.js";
import * as daemon from "./daemon-api.js";

async function wrap<T>(fn: () => Promise<T>): Promise<DaemonResult<T>> {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

interface StreamHandlers {
  onData: Set<(chunk: string) => void>;
  onExit: Set<(exitCode: number | null) => void>;
}

interface StreamEntry {
  ws: WebSocket;
  handlers: StreamHandlers;
  // A resize requested (by TerminalView's ResizeObserver, which fires as
  // soon as the pane mounts) before the socket finishes its handshake would
  // otherwise be silently dropped — unlike the Electron build's ws+unix
  // connection to the daemon, this one is a real loopback TCP handshake
  // through the web server's proxy, slow enough to lose that first resize
  // most of the time. Stashed here and flushed once the socket opens.
  pendingResize?: { cols: number; rows: number };
}

const streams = new Map<number, StreamEntry>();

function openStream(id: number): void {
  if (streams.has(id)) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/terminals/${id}/stream`);
  const handlers: StreamHandlers = { onData: new Set(), onExit: new Set() };
  const entry: StreamEntry = { ws, handlers };
  streams.set(id, entry);

  ws.onopen = () => {
    if (entry.pendingResize) {
      ws.send(JSON.stringify({ type: "resize", ...entry.pendingResize }));
      entry.pendingResize = undefined;
    }
  };

  ws.onmessage = (event) => {
    let msg: unknown;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
    const m = msg as { type: string; data?: string; exitCode?: number | null };
    if (m.type === "output" && typeof m.data === "string") {
      for (const cb of handlers.onData) cb(m.data);
    } else if (m.type === "exit") {
      for (const cb of handlers.onExit) cb(m.exitCode ?? null);
    }
  };
}

export const webApi: Api = {
  getDaemonHealth: () => wrap(daemon.fetchDaemonHealth),

  listConfigRules: () => wrap(daemon.fetchConfigRules),
  createConfigRule: (pattern, context) => wrap(() => daemon.createConfigRule(pattern, context)),
  updateConfigRule: (id, fields) => wrap(() => daemon.updateConfigRule(id, fields)),
  deleteConfigRule: (id) => wrap(() => daemon.deleteConfigRule(id)),

  listNotifications: (unacknowledgedOnly) => wrap(() => daemon.fetchNotifications(unacknowledgedOnly)),
  acknowledgeNotification: (id) => wrap(() => daemon.acknowledgeNotification(id)),

  listCampaigns: () => wrap(daemon.fetchCampaigns),
  listSteps: (campaignId) => wrap(() => daemon.fetchSteps(campaignId)),
  listCampaignPrs: (campaignId, needsMe) =>
    wrap(() => daemon.fetchCampaignPrs(campaignId, needsMe ? "needs-me" : undefined)),
  listCampaignClaims: (campaignId) => wrap(() => daemon.fetchCampaignClaims(campaignId)),
  syncCampaign: (campaignId) => wrap(() => daemon.triggerCampaignSync(campaignId)),
  createCampaign: (name, description, defaultDir) => wrap(() => daemon.createCampaign(name, description, defaultDir)),
  updateCampaign: (id, fields) => wrap(() => daemon.updateCampaign(id, fields)),
  deleteCampaign: (id) => wrap(() => daemon.deleteCampaign(id)),

  listTasks: (campaignId, stepId) => wrap(() => daemon.fetchTasks(campaignId, stepId)),
  createTask: (campaignId, stepId, name, context) => wrap(() => daemon.createTask(campaignId, stepId, name, context)),
  retireTask: (campaignId, stepId, taskId) => wrap(() => daemon.retireTask(campaignId, stepId, taskId)),

  releaseClaim: (prId) => wrap(() => daemon.releasePrClaim(prId)),

  listTerminals: (campaignId) => wrap(() => daemon.listTerminals(campaignId)),
  createTerminal: (campaignId, cwd, label, agentAdapterName, yolo, extraArgs, resumeFromTerminalId) =>
    wrap(() =>
      daemon.createTerminal(campaignId, cwd, label, agentAdapterName, yolo, extraArgs, resumeFromTerminalId),
    ),
  killTerminal: (id) => wrap(() => daemon.killTerminal(id)),
  getTerminalByAgentSession: (agentSessionId) => wrap(() => daemon.getTerminalByAgentSession(agentSessionId)),
  deleteTerminal: (id) => wrap(() => daemon.deleteTerminal(id)),

  listAgentAdapters: () => wrap(daemon.fetchAgentAdapters),

  listLayouts: (campaignId) => wrap(() => daemon.fetchLayouts(campaignId)),
  createLayout: (campaignId, name, tree) => wrap(() => daemon.createLayout(campaignId, name, tree)),
  updateLayout: (id, fields) => wrap(() => daemon.updateLayout(id, fields)),
  deleteLayout: (id) => wrap(() => daemon.deleteLayout(id)),

  openTerminalStream: async (id) => {
    openStream(id);
  },
  closeTerminalStream: async (id) => {
    const entry = streams.get(id);
    if (!entry) return;
    entry.ws.close();
    streams.delete(id);
  },
  writeTerminal: async (id, data) => {
    const ws = streams.get(id)?.ws;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
  },
  resizeTerminal: async (id, cols, rows) => {
    const entry = streams.get(id);
    if (!entry) return;
    if (entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    } else {
      entry.pendingResize = { cols, rows };
    }
  },

  // No custom window chrome or Electron zoom API in a browser tab — App's
  // `chrome={false}` keeps these from ever being called.
  minimizeWindow: async () => {},
  toggleMaximizeWindow: async () => {},
  closeWindow: async () => {},
  isWindowMaximized: async () => false,
  zoomIn: async () => {},
  zoomOut: async () => {},
  zoomReset: async () => {},
  onWindowMaximizeChanged: () => () => {},

  attachTerminal: (id, onData, onExit) => {
    openStream(id);
    const entry = streams.get(id);
    if (!entry) return () => {};
    entry.handlers.onData.add(onData);
    entry.handlers.onExit.add(onExit);
    return () => {
      entry.handlers.onData.delete(onData);
      entry.handlers.onExit.delete(onExit);
    };
  },
};
