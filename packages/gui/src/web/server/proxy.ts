import { request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { socketPath } from "./daemon-paths.js";

// Transparent reverse proxy: forwards /api/* to the daemon over its Unix
// socket verbatim (method, headers, body streamed both ways). The daemon's
// REST routes already match what the renderer expects 1:1 (see
// src/main/daemon-client.ts) — no per-endpoint reimplementation needed here.
export function proxyToDaemon(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? "/api").slice("/api".length) || "/";

  const upstream = request(
    { socketPath, path, method: req.method, headers: req.headers, timeout: 10_000 },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("timeout", () => upstream.destroy(new Error("daemon request timed out")));
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  });

  req.pipe(upstream);
}
