import { connect } from "node:net";
import { request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { socketPath } from "./daemon-paths.js";

// Serves the fleet's shared services at /s/<slug>/..., so one browser origin
// reaches all of them. The daemon knows which loopback port on this machine
// leads to each (the real service where it runs, a relay everywhere else);
// this only maps the slug to it and forwards, with the /s/<slug> prefix
// stripped. Pages that link to absolute paths (/assets/x.js) won't resolve
// under a prefix — that's inherent to path-based proxying.

interface LocalService {
  slug: string;
  name: string;
  port: number;
}

function localServices(): Promise<LocalService[]> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/local/services", method: "GET", timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? (JSON.parse(data) as LocalService[]) : []);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("daemon request timed out")));
    req.on("error", reject);
    req.end();
  });
}

const PREFIX = /^\/s\/([^/?#]+)(\/[^?#]*)?(\?.*)?$/;

export function isServicePath(url: string | undefined): boolean {
  return !!url && url.startsWith("/s/");
}

function resolveTarget(url: string) {
  const match = url.match(PREFIX);
  if (!match) return null;
  return { slug: decodeURIComponent(match[1]!), rest: match[2], query: match[3] ?? "" };
}

function notFound(res: ServerResponse, slug: string, known: LocalService[]): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(
    `No shared service "${slug}" is reachable from this machine.\n` +
      (known.length > 0 ? `Available: ${known.map((s) => s.slug).join(", ")}\n` : "None are shared.\n"),
  );
}

export async function proxyToService(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const target = resolveTarget(req.url ?? "");
  if (!target) {
    res.writeHead(404).end();
    return;
  }
  // Without the trailing slash, relative links in the page would resolve
  // against /s/ instead of the service.
  if (target.rest === undefined) {
    res.writeHead(308, { Location: `/s/${encodeURIComponent(target.slug)}/${target.query}` }).end();
    return;
  }

  let known: LocalService[];
  try {
    known = await localServices();
  } catch (err) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end(`daemon unreachable: ${(err as Error).message}\n`);
    return;
  }
  const service = known.find((s) => s.slug === target.slug);
  if (!service) {
    notFound(res, target.slug, known);
    return;
  }

  const prefix = `/s/${encodeURIComponent(target.slug)}`;
  const upstream = request(
    {
      host: "127.0.0.1",
      port: service.port,
      path: target.rest + target.query,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${service.port}`, "x-forwarded-prefix": prefix },
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      // A redirect to an absolute path would otherwise leave the prefix.
      if (typeof headers.location === "string" && /^\/(?!\/)/.test(headers.location)) {
        headers.location = prefix + headers.location;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`${service.name} didn't answer: ${err.message}\n`);
  });
  req.pipe(upstream);
}

// WebSockets (and anything else that upgrades): replay the request on a raw
// connection to the service and let both sides talk directly.
export async function upgradeToService(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const target = resolveTarget(req.url ?? "");
  const service = target?.rest !== undefined ? (await localServices().catch(() => [])).find((s) => s.slug === target.slug) : undefined;
  if (!target || !service) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }

  const upstream = connect(service.port, "127.0.0.1", () => {
    const lines = [`${req.method} ${target.rest}${target.query} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!;
      lines.push(`${name}: ${name.toLowerCase() === "host" ? `127.0.0.1:${service.port}` : req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
}
