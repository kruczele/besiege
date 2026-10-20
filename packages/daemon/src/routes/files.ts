// The editor pane's file access. A pane names a machine and a path; this
// serves the local disk itself or relays to the peer that owns it, the same
// way terminal streams are relayed (routes/terminals.ts).
import type { FastifyInstance } from "fastify";
import { listDirectory, readTextFile, writeTextFile } from "../files.js";
import { fleetToken, hostUrl } from "../fleet.js";
import { hostId as selfId } from "../host.js";
import { listDirectoryRemote, readFileRemote, RemoteFileError, writeFileRemote } from "../remote-exec.js";
import { fileFailure } from "./exec.js";

function remoteTarget(host: string | undefined): { url: string } | null {
  if (!host || host.toLowerCase() === selfId) return null;
  const url = hostUrl(host.toLowerCase());
  if (!url) throw new RemoteFileError(`${host} is unreachable`, 502);
  return { url };
}

export function registerFileRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { host?: string; path?: string } }>("/files", async (req, reply) => {
    try {
      const path = req.query.path ?? "";
      const remote = remoteTarget(req.query.host);
      return remote ? await readFileRemote(remote.url, fleetToken(), path) : await readTextFile(path);
    } catch (err) {
      return relayFailure(reply, err);
    }
  });

  app.get<{ Querystring: { host?: string; path?: string } }>("/files/list", async (req, reply) => {
    try {
      const path = req.query.path ?? "";
      const remote = remoteTarget(req.query.host);
      return remote ? await listDirectoryRemote(remote.url, fleetToken(), path) : await listDirectory(path);
    } catch (err) {
      return relayFailure(reply, err);
    }
  });

  app.put<{ Body: { host?: string; path?: string; content?: string; expectedMtimeMs?: number } }>(
    "/files",
    async (req, reply) => {
      const { host, path, content, expectedMtimeMs } = req.body ?? {};
      if (typeof path !== "string" || typeof content !== "string") {
        reply.code(400);
        return { error: "path and content are required" };
      }
      try {
        const remote = remoteTarget(host);
        return remote
          ? await writeFileRemote(remote.url, fleetToken(), { path, content, expectedMtimeMs })
          : await writeTextFile(path, content, expectedMtimeMs);
      } catch (err) {
        return relayFailure(reply, err);
      }
    },
  );
}

function relayFailure(reply: Parameters<typeof fileFailure>[0], err: unknown) {
  if (err instanceof RemoteFileError) {
    reply.code(err.status);
    return { error: err.message };
  }
  return fileFailure(reply, err);
}
