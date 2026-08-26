import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors packages/daemon/src/paths.ts — must stay in sync with it.
// Worth extracting into a shared workspace package once a third
// consumer (TUI, MCP server, wrapper) needs the same resolution.
const override = process.env.BESIEGE_STATE_DIR;
const xdgStateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
export const stateDir = override ?? join(xdgStateHome, "besiege");
export const socketPath = join(stateDir, "daemon.sock");
