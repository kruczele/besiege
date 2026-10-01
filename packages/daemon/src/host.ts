import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

// The name this daemon goes by in fleet.yaml and in every terminal_sessions
// row it executes. macOS hostnames usually carry a ".local" suffix, and
// Tailscale lowercases machine names, so normalize to match what you'd
// naturally type in the config.
export const hostId = (process.env.BESIEGE_HOST_ID ?? hostname().split(".")[0]).toLowerCase();

// Changes on every daemon start. The control plane uses a change in a
// host's bootId to tell "its PTYs died with a restart" apart from "it just
// missed a heartbeat or two".
export const bootId = randomUUID();

// Set by a follower's dispatcher on everything it forwards to the primary,
// so the scheduler knows which machine a spawn request came from.
export const ORIGIN_HOST_HEADER = "x-besiege-origin-host";
