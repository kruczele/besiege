import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { registerHealthRoute } from "./routes/health.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerPrRoutes } from "./routes/prs.js";
import { registerFailureRoutes } from "./routes/failures.js";
import type { syncPr, syncCampaign } from "./github.js";

type SyncPrFn = typeof syncPr;
type SyncCampaignFn = typeof syncCampaign;

export function buildServer(
  db: Database.Database,
  syncPrFn: SyncPrFn | null = null,
  syncCampaignFn: SyncCampaignFn | null = null,
): FastifyInstance {
  const app = Fastify({ logger: true });

  registerHealthRoute(app, db, Date.now());
  registerConfigRoutes(app, db);
  registerNotificationRoutes(app, db);
  registerCampaignRoutes(app, db);
  registerTaskRoutes(app, db);
  registerPrRoutes(app, db, syncPrFn, syncCampaignFn);
  registerFailureRoutes(app, db);

  return app;
}
