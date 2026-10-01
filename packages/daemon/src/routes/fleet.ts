import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { fleetConfigError, fleetConfigPath } from "../fleet-config.js";
import { listHosts, recordHeartbeat } from "../fleet.js";
import type { Heartbeat } from "../heartbeat.js";
import { hostId } from "../host.js";
import { reconcileHost } from "../terminals.js";

export function registerFleetRoutes(app: FastifyInstance, db: Database.Database) {
  app.post<{ Body: Heartbeat }>("/fleet/heartbeat", async (req, reply) => {
    const hb = req.body;
    if (!hb || typeof hb.hostId !== "string" || typeof hb.bootId !== "string" || !Array.isArray(hb.execs)) {
      reply.code(400);
      return { error: "malformed heartbeat" };
    }
    hb.hostId = hb.hostId.toLowerCase();
    const previousBootId = recordHeartbeat(db, hb);
    // Resuming sessions after a host restart can take a few seconds; the
    // sender doesn't need to wait for it.
    void reconcileHost(db, hb, previousBootId).catch((err) =>
      console.error(`reconciling ${hb.hostId} failed: ${(err as Error).message}`),
    );
    reply.code(204);
  });

  app.get("/fleet/hosts", async () => ({
    controlPlane: hostId,
    configPath: fleetConfigPath,
    configError: fleetConfigError(),
    hosts: listHosts(db),
  }));
}
