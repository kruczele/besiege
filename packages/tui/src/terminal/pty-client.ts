// WS attach to a daemon-owned pty session, direct analog of
// packages/gui/src/main/terminal-bridge.ts minus the Electron multi-subscriber
// fan-out (one blessed pane owns exactly one connection here).
import { WebSocket } from "ws";
import { socketPath } from "../daemon/client.js";

export interface PtyConnection {
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (exitCode: number | null) => void): void;
  onError(cb: (message: string) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export function attachPty(id: number): PtyConnection {
  const ws = new WebSocket(`ws+unix://${socketPath}:/terminals/${id}/stream`);

  const dataCbs: ((chunk: string) => void)[] = [];
  const exitCbs: ((exitCode: number | null) => void)[] = [];
  const errorCbs: ((message: string) => void)[] = [];

  ws.on("message", (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
    const m = msg as { type: string; data?: string; exitCode?: number | null; message?: string };
    if (m.type === "output" && typeof m.data === "string") {
      for (const cb of dataCbs) cb(m.data);
    } else if (m.type === "exit") {
      for (const cb of exitCbs) cb(m.exitCode ?? null);
    } else if (m.type === "error" && typeof m.message === "string") {
      for (const cb of errorCbs) cb(m.message);
    }
  });

  ws.on("error", (err) => {
    for (const cb of errorCbs) cb(err.message);
  });

  return {
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    onError: (cb) => errorCbs.push(cb),
    write: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    },
    resize: (cols, rows) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    },
    close: () => ws.close(),
  };
}
