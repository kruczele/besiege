// The source side of a shared service (see services.ts). Like /exec/*, only
// reachable remotely through the token-gated TCP listener, and it will only
// dial ports this host has been told it shares — the fleet token alone
// doesn't make it a general loopback proxy.
import type { FastifyInstance } from "fastify";
import { isServed, openTunnel } from "../services.js";

export function registerTunnelRoutes(app: FastifyInstance) {
  app.get<{ Params: { port: string } }>(
    "/tunnel/:port",
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!isServed(Number(req.params.port))) {
          reply.code(403).send({ error: "port is not shared" });
        }
      },
    },
    (socket, req) => openTunnel(socket, Number(req.params.port)),
  );
}
