import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors packages/daemon/src/paths.ts and src/main/daemon-paths.ts — must
// stay in sync with both. Duplicated here (rather than imported) so this
// package's rootDir stays scoped to src/web/server, keeping the compiled
// entrypoint at out/web-server/index.js.
const override = process.env.BESIEGE_STATE_DIR;
const xdgStateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
export const stateDir = override ?? join(xdgStateHome, "besiege");
export const socketPath = join(stateDir, "daemon.sock");
