// What every host exposes so a control plane can run sessions on it. Only
// reachable remotely through the token-gated TCP listener (server.ts).
import type { FastifyInstance, FastifyReply } from "fastify";
import { FileError, listDirectory, readTextFile, writeTextFile } from "../files.js";
import type { WakeConfig } from "../fleet-config.js";
import * as ptyHost from "../pty-host.js";
import { LaunchError, type LaunchSpec } from "../pty-host.js";
import { performWake } from "../wake.js";
import { handleViewerMessages } from "./terminals.js";

export function fileFailure(reply: FastifyReply, err: unknown) {
  reply.code(err instanceof FileError ? err.status : 500);
  return { error: (err as Error).message };
}

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

  app.get<{ Querystring: { path?: string } }>("/exec/files", async (req, reply) => {
    try {
      return await readTextFile(req.query.path ?? "");
    } catch (err) {
      return fileFailure(reply, err);
    }
  });

  app.get<{ Querystring: { path?: string } }>("/exec/files/list", async (req, reply) => {
    try {
      return await listDirectory(req.query.path ?? "");
    } catch (err) {
      return fileFailure(reply, err);
    }
  });

  app.put<{ Body: { path?: string; content?: string; expectedMtimeMs?: number } }>("/exec/files", async (req, reply) => {
    const { path, content, expectedMtimeMs } = req.body ?? {};
    if (typeof path !== "string" || typeof content !== "string") {
      reply.code(400);
      return { error: "path and content are required" };
    }
    try {
      return await writeTextFile(path, content, expectedMtimeMs);
    } catch (err) {
      return fileFailure(reply, err);
    }
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
