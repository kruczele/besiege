import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type Database from "better-sqlite3";
import { registerHealthRoute } from "./routes/health.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerPrRoutes } from "./routes/prs.js";
import { registerFailureRoutes } from "./routes/failures.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerLayoutRoutes } from "./routes/layouts.js";
import type { syncPr, syncCampaign } from "./github.js";

type SyncPrFn = typeof syncPr;
type SyncCampaignFn = typeof syncCampaign;

export async function buildServer(
  db: Database.Database,
  syncPrFn: SyncPrFn | null = null,
  syncCampaignFn: SyncCampaignFn | null = null,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

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
  registerCampaignRoutes(app, db);
  registerTaskRoutes(app, db);
  registerPrRoutes(app, db, syncPrFn, syncCampaignFn);
  registerFailureRoutes(app, db);
  registerTerminalRoutes(app, db);
  registerAgentRoutes(app);
  registerLayoutRoutes(app, db);

  return app;
}
