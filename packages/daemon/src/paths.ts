import { homedir } from "node:os";
import { join } from "node:path";

// Override for local dev if you don't want state under XDG_STATE_HOME.
const override = process.env.CCD_STATE_DIR;

const xdgStateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

export const stateDir = override ?? join(xdgStateHome, "cc-agent-daemon");

export const socketPath = join(stateDir, "daemon.sock");
export const dbPath = join(stateDir, "daemon.db");
export const pidPath = join(stateDir, "daemon.pid");
