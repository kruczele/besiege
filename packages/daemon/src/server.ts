import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { registerHealthRoute } from "./routes/health.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerNotificationRoutes } from "./routes/notifications.js";

export function buildServer(db: Database.Database): FastifyInstance {
  const app = Fastify({ logger: true });

  registerHealthRoute(app, db, Date.now());
  registerConfigRoutes(app, db);
  registerNotificationRoutes(app, db);

  return app;
}
