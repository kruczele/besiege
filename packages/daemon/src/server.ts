import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

export function buildServer(db: Database.Database): FastifyInstance {
  const app = Fastify({ logger: true });

  const startedAt = Date.now();

  app.get("/health", async () => {
    const startupCount = (
      db.prepare("SELECT COUNT(*) AS count FROM daemon_startups").get() as { count: number }
    ).count;

    const lastStartedAt = (
      db.prepare("SELECT started_at FROM daemon_startups ORDER BY id DESC LIMIT 1").get() as
        | { started_at: string }
        | undefined
    )?.started_at;

    return {
      status: "ok",
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      db: { startupCount, lastStartedAt },
    };
  });

  return app;
}
