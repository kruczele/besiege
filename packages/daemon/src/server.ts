import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type Database from "better-sqlite3";
import { registerHealthRoute } from "./routes/health.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerStatusUpdateRoutes } from "./routes/status-updates.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerPrRoutes } from "./routes/prs.js";
import { registerFailureRoutes } from "./routes/failures.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerLayoutRoutes } from "./routes/layouts.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerExecRoutes } from "./routes/exec.js";
import { registerFleetRoutes } from "./routes/fleet.js";
import { registerTunnelRoutes } from "./routes/tunnel.js";
import type { syncPr, syncCampaign } from "./github.js";

type SyncPrFn = typeof syncPr;
type SyncCampaignFn = typeof syncCampaign;

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
const SLOW_REQUEST_MS = 1000;

function logLevel(): string {
  const level = process.env.BESIEGE_LOG_LEVEL;
  return level && LOG_LEVELS.includes(level) ? level : "info";
}

export async function buildServer(
  db: Database.Database,
  syncPrFn: SyncPrFn | null = null,
  syncCampaignFn: SyncCampaignFn | null = null,
  // Set only for the TCP-exposed instance (see index.ts) — a machine acting
  // as a remote peer for another one. The unix-socket instances (this
  // machine's own internal app, and historically the sole instance before
  // the dispatcher existed) stay unauthenticated, matching the existing
  // trusted-local-access assumption. Several are accepted on a host that
  // is both a peer for others and a follower of a primary: its own token,
  // and the primary's, which the primary presents when it calls /exec/*.
  authTokens?: string[],
): Promise<FastifyInstance> {
  // The GUI/WUI poll several endpoints per second, so Fastify's per-request
  // lines (two per request) are replaced by the onResponse hook below, which
  // only keeps failures and slow requests at info+. Everything else is
  // debug, i.e. visible with BESIEGE_LOG_LEVEL=debug.
  const app = Fastify({ logger: { level: logLevel() }, disableRequestLogging: true });

  // disableRequestLogging also silences Fastify's own logging of errors
  // thrown by handlers, so log those (with the stack) here.
  app.addHook("onError", (req, _reply, err, done) => {
    if (((err as { statusCode?: number }).statusCode ?? 500) >= 500) req.log.error({ err }, "request errored");
    done();
  });

  app.addHook("onResponse", (req, reply, done) => {
    const { statusCode } = reply;
    const responseTime = Math.round(reply.elapsedTime);
    const level =
      statusCode >= 500 ? "error" : statusCode >= 400 || responseTime > SLOW_REQUEST_MS ? "warn" : "debug";
    req.log[level]({ req: req, res: reply, responseTime }, "request completed");
    done();
  });

  if (authTokens) {
    const accepted = new Set(authTokens.map((t) => `Bearer ${t}`));
    app.addHook("onRequest", (req, reply, done) => {
      if (!accepted.has(req.headers.authorization ?? "")) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
      done();
    });
  }

  // Must be awaited: @fastify/websocket's onRoute hook (which turns a
  // {websocket:true} route option into an actual WS upgrade handler) only
  // applies to routes registered *after* the hook exists. Registering
  // without awaiting defers the plugin body via avvio's boot queue, so any
  // route registered synchronously right after would silently fall back to
  // being treated as a plain HTTP handler instead of a websocket one.
  await app.register(fastifyWebsocket);

  registerHealthRoute(app, db, Date.now());
  registerConfigRoutes(app, db);
  registerNotificationRoutes(app, db);
  registerStatusUpdateRoutes(app, db);
  registerCampaignRoutes(app, db);
  registerTaskRoutes(app, db);
  registerPrRoutes(app, db, syncPrFn, syncCampaignFn);
  registerFailureRoutes(app, db);
  registerTerminalRoutes(app, db);
  registerAgentRoutes(app);
  registerLayoutRoutes(app, db);
  registerExecRoutes(app);
  registerFileRoutes(app);
  registerFleetRoutes(app, db);
  registerTunnelRoutes(app);

  return app;
}
