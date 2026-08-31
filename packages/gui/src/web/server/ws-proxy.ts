import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { socketPath } from "./daemon-paths.js";

const wss = new WebSocketServer({ noServer: true });

// Proxies a browser WebSocket straight through to the daemon's own
// /terminals/:id/stream socket — same ws+unix:// technique already used by
// src/main/terminal-bridge.ts, just piping WS↔WS directly instead of
// forwarding over Electron IPC.
export function proxyTerminalStream(id: number, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  wss.handleUpgrade(req, socket, head, (browserWs) => {
    const daemonWs = new WebSocket(`ws+unix://${socketPath}:/terminals/${id}/stream`);

    // `ws` always hands "message" listeners a Buffer, even for text frames
    // (it never auto-decodes based on the original opcode) — sending that
    // Buffer straight through would make `ws.send` pick a binary opcode,
    // and the browser's own WebSocket (binaryType "blob" by default) then
    // hands JSON.parse a Blob instead of a string, throwing silently and
    // dropping every output frame. Stringify explicitly so it round-trips
    // as the text frame the daemon actually sent.
    daemonWs.on("message", (data) => {
      if (browserWs.readyState === browserWs.OPEN) browserWs.send(data.toString());
    });
    daemonWs.on("close", () => browserWs.close());
    daemonWs.on("error", () => browserWs.close());

    browserWs.on("message", (data) => {
      if (daemonWs.readyState === daemonWs.OPEN) daemonWs.send(data);
    });
    browserWs.on("close", () => daemonWs.close());
    browserWs.on("error", () => daemonWs.close());
  });
}
