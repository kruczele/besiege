// Owns the public socketPath every client (Electron, the web proxy,
// hooks/MCP) already connects to. Per request/WS upgrade, forwards to a
// configured remote peer when it's currently reachable, otherwise to this
// machine's own local Fastify app (bound to internalSocketPath instead of
// socketPath — see index.ts) — so every existing client gets
// remote-preferred/local-fallback behavior with no changes of its own.
// Modeled on packages/gui/src/web/server/proxy.ts + ws-proxy.ts, generalized
// to pick a target dynamically instead of always the local socket.
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const HEALTH_CHECK_INTERVAL_MS = 3000;
const HEALTH_CHECK_TIMEOUT_MS = 1500;

interface DispatcherOptions {
  publicSocketPath: string;
  internalSocketPath: string;
  // e.g. "http://100.x.y.z:4570" — a remote peer daemon's TCP listener.
  primaryUrl?: string;
  primaryToken?: string;
}

export function startDispatcher(opts: DispatcherOptions): { close(): void } {
  const primary = opts.primaryUrl ? new URL(opts.primaryUrl) : null;
  // Starts false so requests before the first health check resolves fail
  // safe to local instead of hanging on an unproven peer.
  let reachable = false;

  function checkHealth(): void {
    if (!primary) return;
    const req = httpRequest(
      {
        hostname: primary.hostname,
        port: primary.port,
        path: "/health",
        method: "GET",
        timeout: HEALTH_CHECK_TIMEOUT_MS,
        headers: opts.primaryToken ? { Authorization: `Bearer ${opts.primaryToken}` } : undefined,
      },
      (res) => {
        reachable = !!res.statusCode && res.statusCode < 300;
        res.resume();
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {
      reachable = false;
    });
    req.end();
  }

  checkHealth();
  const healthTimer = primary ? setInterval(checkHealth, HEALTH_CHECK_INTERVAL_MS) : undefined;

  function httpTarget(path: string, method: string | undefined, headers: IncomingMessage["headers"]) {
    if (primary && reachable) {
      return {
        hostname: primary.hostname,
        port: primary.port,
        path,
        method,
        headers: { ...headers, authorization: opts.primaryToken ? `Bearer ${opts.primaryToken}` : undefined },
        timeout: 10_000,
      };
    }
    return { socketPath: opts.internalSocketPath, path, method, headers, timeout: 10_000 };
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const provisionallyRemote = !!(primary && reachable);
    const upstream = httpRequest(httpTarget(req.url ?? "/", req.method, req.headers), (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("upstream request timed out")));
    upstream.on("error", (err) => {
      // Don't wait for the next health-check tick to notice the primary
      // dropped mid-window — the next request fails over immediately instead
      // of also 502ing.
      if (provisionallyRemote) reachable = false;
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
    req.pipe(upstream);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = req.url ?? "/";
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const useRemote = primary && reachable;
      const targetUrl = useRemote
        ? `ws://${primary.hostname}:${primary.port}${path}`
        : `ws+unix://${opts.internalSocketPath}:${path}`;
      const upstreamWs = new WebSocket(
        targetUrl,
        useRemote && opts.primaryToken ? { headers: { Authorization: `Bearer ${opts.primaryToken}` } } : undefined,
      );

      // Same "always stringify before re-sending" fix as ws-proxy.ts: `ws`
      // hands "message" a Buffer even for text frames, and re-sending that
      // Buffer verbatim would flip the outgoing frame to binary opcode.
      upstreamWs.on("message", (data) => {
        if (clientWs.readyState === clientWs.OPEN) clientWs.send(data.toString());
      });
      upstreamWs.on("close", () => clientWs.close());
      upstreamWs.on("error", () => {
        if (useRemote) reachable = false;
        clientWs.close();
      });

      clientWs.on("message", (data) => {
        if (upstreamWs.readyState === upstreamWs.OPEN) upstreamWs.send(data);
      });
      clientWs.on("close", () => upstreamWs.close());
      clientWs.on("error", () => upstreamWs.close());
    });
  });

  server.listen(opts.publicSocketPath);

  return {
    close() {
      if (healthTimer) clearInterval(healthTimer);
      server.close();
    },
  };
}
