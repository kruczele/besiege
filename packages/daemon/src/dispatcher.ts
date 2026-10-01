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
import { hostId, ORIGIN_HOST_HEADER } from "./host.js";

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

  // /exec/* is always about this machine's own PTYs (it's what a primary
  // calls, and what localExecFor below attaches to), never the primary's.
  const isLocalOnly = (path: string) => path.startsWith("/exec/");

  function httpTarget(path: string, method: string | undefined, headers: IncomingMessage["headers"]) {
    if (primary && reachable && !isLocalOnly(path)) {
      return {
        hostname: primary.hostname,
        port: primary.port,
        path,
        method,
        headers: {
          ...headers,
          authorization: opts.primaryToken ? `Bearer ${opts.primaryToken}` : undefined,
          [ORIGIN_HOST_HEADER]: hostId,
        },
        timeout: 10_000,
      };
    }
    return { socketPath: opts.internalSocketPath, path, method, headers, timeout: 10_000 };
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const provisionallyRemote = !!(primary && reachable && !isLocalOnly(req.url ?? "/"));
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

  // The primary knows which host runs a session; if it's this one, attach
  // straight to the local PTY rather than routing every keystroke out to
  // the primary and back.
  async function localExecFor(path: string): Promise<string | null> {
    const match = path.match(/^\/terminals\/(\d+)\/stream$/);
    if (!match || !primary) return null;
    try {
      const res = await fetch(new URL(`/terminals/${match[1]}`, primary), {
        headers: opts.primaryToken ? { Authorization: `Bearer ${opts.primaryToken}` } : undefined,
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const session = (await res.json()) as { hostId?: string; execId?: string | null; status?: string };
      return session.hostId === hostId && session.execId && session.status === "active" ? session.execId : null;
    } catch {
      return null;
    }
  }

  function pipe(clientWs: WebSocket, targetUrl: string, headers: Record<string, string> | undefined, onError: () => void) {
    const upstreamWs = new WebSocket(targetUrl, headers ? { headers } : undefined);
    const pending: string[] = [];
    upstreamWs.on("open", () => {
      for (const msg of pending.splice(0)) upstreamWs.send(msg);
    });

    // Same "always stringify before re-sending" fix as ws-proxy.ts: `ws`
    // hands "message" a Buffer even for text frames, and re-sending that
    // Buffer verbatim would flip the outgoing frame to binary opcode.
    upstreamWs.on("message", (data) => {
      if (clientWs.readyState === clientWs.OPEN) clientWs.send(data.toString());
    });
    upstreamWs.on("close", () => clientWs.close());
    upstreamWs.on("error", () => {
      onError();
      clientWs.close();
    });

    // Buffered while connecting: the local-exec lookup means a client's
    // first resize can arrive before the upstream socket is open.
    clientWs.on("message", (data) => {
      const text = data.toString();
      if (upstreamWs.readyState === upstreamWs.OPEN) upstreamWs.send(text);
      else if (upstreamWs.readyState === upstreamWs.CONNECTING) pending.push(text);
    });
    clientWs.on("close", () => upstreamWs.close());
    clientWs.on("error", () => upstreamWs.close());
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = req.url ?? "/";
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      // Buffer until the target is known, so nothing the client sends while
      // localExecFor is in flight is lost.
      const early: string[] = [];
      const collect = (data: unknown) => early.push(String(data));
      clientWs.on("message", collect);

      const useRemote = !!(primary && reachable && !isLocalOnly(path));
      void (useRemote ? localExecFor(path) : Promise.resolve(null)).then((localExecId) => {
        clientWs.off("message", collect);
        if (localExecId) {
          pipe(clientWs, `ws+unix://${opts.internalSocketPath}:/exec/sessions/${localExecId}/stream`, undefined, () => {});
        } else if (useRemote) {
          pipe(
            clientWs,
            `ws://${primary!.hostname}:${primary!.port}${path}`,
            opts.primaryToken ? { Authorization: `Bearer ${opts.primaryToken}` } : undefined,
            () => {
              reachable = false;
            },
          );
        } else {
          pipe(clientWs, `ws+unix://${opts.internalSocketPath}:${path}`, undefined, () => {});
        }
        for (const msg of early) clientWs.emit("message", Buffer.from(msg));
      });
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
