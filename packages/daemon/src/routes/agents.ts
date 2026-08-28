import type { FastifyInstance } from "fastify";
import { loadAgentConfigs } from "../agent-config.js";

// Read-only: agent adapters are a hand-edited YAML config now (see
// agent-config.ts), not a database table — there's nothing to create,
// update, or delete through the API any more.
export function registerAgentRoutes(app: FastifyInstance) {
  app.get("/agents", async () => loadAgentConfigs());
}
