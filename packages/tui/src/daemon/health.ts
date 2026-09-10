import { callDaemon } from "./client.js";
import type { DaemonHealth } from "./types.js";

export const fetchDaemonHealth = () => callDaemon<DaemonHealth>("GET", "/health");
