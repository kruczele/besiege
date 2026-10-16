import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { fleetConfigError, fleetConfigPath } from "../fleet-config.js";
import { hostUrl, listHosts, recordHeartbeat } from "../fleet.js";
import type { Heartbeat } from "../heartbeat.js";
import { hostId } from "../host.js";
import {
  assignmentsFor,
  createService,
  deleteService,
  getService,
  listServices,
  parseServiceInput,
  slugOf,
  recordRelayStatuses,
  updateService,
} from "../services.js";
import { reconcileHost } from "../terminals.js";

// Names become URL segments (/s/<slug>/), so two services can't share one.
function slugTaken(db: Database.Database, name: string, exceptId?: number): boolean {
  return listServices(db).some((s) => s.id !== exceptId && slugOf(s.name) === slugOf(name));
}

export function registerFleetRoutes(app: FastifyInstance, db: Database.Database) {
  app.post<{ Body: Heartbeat }>("/fleet/heartbeat", async (req, reply) => {
    const hb = req.body;
    if (!hb || typeof hb.hostId !== "string" || typeof hb.bootId !== "string" || !Array.isArray(hb.execs)) {
      reply.code(400);
      return { error: "malformed heartbeat" };
    }
    hb.hostId = hb.hostId.toLowerCase();
    const previousBootId = recordHeartbeat(db, hb);
    recordRelayStatuses(hb.hostId, hb.relays);
    // Resuming sessions after a host restart can take a few seconds; the
    // sender doesn't need to wait for it.
    void reconcileHost(db, hb, previousBootId).catch((err) =>
      console.error(`reconciling ${hb.hostId} failed: ${(err as Error).message}`),
    );
    return { assignments: assignmentsFor(db, hb.hostId, hostUrl) };
  });

  app.get("/fleet/hosts", async () => ({
    controlPlane: hostId,
    configPath: fleetConfigPath,
    configError: fleetConfigError(),
    hosts: listHosts(db),
  }));

  app.post("/fleet/services", async (req, reply) => {
    const input = parseServiceInput(req.body);
    if ("error" in input) {
      reply.code(400);
      return input;
    }
    if (slugTaken(db, input.name)) {
      reply.code(409);
      return { error: "another service already has this name" };
    }
    reply.code(201);
    return createService(db, input);
  });

  app.patch<{ Params: { id: string } }>("/fleet/services/:id", async (req, reply) => {
    const current = getService(db, Number(req.params.id));
    if (!current) {
      reply.code(404);
      return { error: "not found" };
    }
    const input = parseServiceInput(req.body, current);
    if ("error" in input) {
      reply.code(400);
      return input;
    }
    if (slugTaken(db, input.name, current.id)) {
      reply.code(409);
      return { error: "another service already has this name" };
    }
    return updateService(db, current.id, input);
  });

  app.delete<{ Params: { id: string } }>("/fleet/services/:id", async (req, reply) => {
    if (!deleteService(db, Number(req.params.id))) {
      reply.code(404);
      return { error: "not found" };
    }
    reply.code(204);
  });
}
