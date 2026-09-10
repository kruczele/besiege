import { callDaemon } from "./client.js";
import type { AgentAdapter } from "./types.js";

// Hand-edited YAML config — read-only from any client.
export const fetchAgentAdapters = () => callDaemon<AgentAdapter[]>("GET", "/agents");
