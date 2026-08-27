import { WebSocket } from "ws";
import type { WebContents } from "electron";
import { socketPath } from "./daemon-paths.js";

interface Connection {
  ws: WebSocket;
  subscribers: Set<WebContents>;
}

const connections = new Map<number, Connection>();

function forward(webContents: WebContents, channel: string, payload: unknown): void {
  if (!webContents.isDestroyed()) webContents.send(channel, payload);
}

export function attach(webContents: WebContents, id: number): void {
  const existing = connections.get(id);
  if (existing) {
    existing.subscribers.add(webContents);
    return;
  }

  const ws = new WebSocket(`ws+unix://${socketPath}:/terminals/${id}/stream`);
  const conn: Connection = { ws, subscribers: new Set([webContents]) };
  connections.set(id, conn);

  ws.on("message", (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
    const m = msg as { type: string; data?: string; exitCode?: number | null };
    for (const wc of conn.subscribers) {
      if (m.type === "output" && typeof m.data === "string") {
        forward(wc, "terminal:data", { id, chunk: m.data });
      } else if (m.type === "exit") {
        forward(wc, "terminal:exit", { id, exitCode: m.exitCode ?? null });
      }
    }
  });

  ws.on("close", () => {
    connections.delete(id);
  });

  ws.on("error", () => {
    connections.delete(id);
  });
}

export function detach(webContents: WebContents, id: number): void {
  const conn = connections.get(id);
  if (!conn) return;
  conn.subscribers.delete(webContents);
  if (conn.subscribers.size === 0) {
    conn.ws.close();
    connections.delete(id);
  }
}

export function write(id: number, data: string): boolean {
  const conn = connections.get(id);
  if (!conn || conn.ws.readyState !== conn.ws.OPEN) return false;
  conn.ws.send(JSON.stringify({ type: "input", data }));
  return true;
}

export function resize(id: number, cols: number, rows: number): boolean {
  const conn = connections.get(id);
  if (!conn || conn.ws.readyState !== conn.ws.OPEN) return false;
  conn.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  return true;
}

// Detach every connection this webContents was subscribed to — called when a window closes.
export function detachAll(webContents: WebContents): void {
  for (const id of [...connections.keys()]) {
    detach(webContents, id);
  }
}
