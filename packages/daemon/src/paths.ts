import { homedir } from "node:os";
import { join } from "node:path";

// Override for local dev if you don't want state under XDG_STATE_HOME.
const override = process.env.BESIEGE_STATE_DIR;

const xdgStateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

export const stateDir = override ?? join(xdgStateHome, "besiege");

export const socketPath = join(stateDir, "daemon.sock");
export const dbPath = join(stateDir, "daemon.db");
export const pidPath = join(stateDir, "daemon.pid");

// `socketPath` is the address every client connects to (unchanged), now
// fronted by the dispatcher (see dispatcher.ts) that picks per-request
// between a configured remote peer and this machine's own Fastify app, which
// binds here instead of `socketPath` directly.
export const internalSocketPath = join(stateDir, "daemon.internal.sock");

// Bearer token for the optional TCP listener (see tcp-token.ts) that lets
// another machine's daemon use this one as its remote peer.
export const tcpTokenPath = join(stateDir, "tcp-token");
