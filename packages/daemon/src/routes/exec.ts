// What every host exposes so a control plane can run sessions on it. Only
// reachable remotely through the token-gated TCP listener (server.ts).
import type { FastifyInstance } from "fastify";
import type { WakeConfig } from "../fleet-config.js";
import * as ptyHost from "../pty-host.js";
import { LaunchError, type LaunchSpec } from "../pty-host.js";
import { performWake } from "../wake.js";
import { handleViewerMessages } from "./terminals.js";

export function registerExecRoutes(app: FastifyInstance) {
  app.post<{ Body: LaunchSpec }>("/exec/sessions", async (req, reply) => {
    const spec = req.body;
    if (!spec || typeof spec.cwd !== "string" || typeof spec.sessionId !== "string" || typeof spec.owner !== "string") {
      reply.code(400);
      return { error: "cwd, sessionId and owner are required" };
    }
    try {
      reply.code(201);
      return ptyHost.launch(spec);
    } catch (err) {
      reply.code(err instanceof LaunchError ? 422 : 500);
      return { error: (err as Error).message };
    }
  });

  app.get("/exec/sessions", async () => ptyHost.listExecs());

  app.post<{ Params: { execId: string } }>("/exec/sessions/:execId/kill", async (req, reply) => {
    if (!ptyHost.kill(req.params.execId)) {
      reply.code(404);
      return { error: "not found" };
    }
    return { ok: true };
  });

  app.get<{ Params: { execId: string } }>("/exec/sessions/:execId/stream", { websocket: true }, (socket, req) => {
    if (!ptyHost.attach(req.params.execId, socket)) {
      socket.send(JSON.stringify({ type: "error", message: "session not active" }));
      socket.close();
      return;
    }
    handleViewerMessages(socket, req.params.execId);
  });

  app.post<{ Body: WakeConfig }>("/exec/wake", async (req, reply) => {
    try {
      await performWake(req.body);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
  });
}
