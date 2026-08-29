import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

// Small hand-rolled static server for the built web client (out/web) — the
// asset set here is small and fixed, not worth a dependency for it.
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const requested = normalize(join(root, url.pathname));
  // Guard against path traversal escaping `root` via "..".
  const path = requested.startsWith(root) && existsSync(requested) && statSync(requested).isFile()
    ? requested
    : join(root, "index.html");

  res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(res);
}
