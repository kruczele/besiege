import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { openDb } from "./db.js";
import { buildServer } from "./server.js";
import { dbPath, pidPath, socketPath, stateDir } from "./paths.js";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSingleInstanceLock(): void {
  mkdirSync(stateDir, { recursive: true });

  if (existsSync(pidPath)) {
    const existingPid = Number(readFileSync(pidPath, "utf8").trim());
    if (Number.isInteger(existingPid) && processIsAlive(existingPid)) {
      console.error(`daemon already running (pid ${existingPid}, state dir ${stateDir})`);
      process.exit(1);
    }
    // Stale pidfile from an unclean shutdown — clear it and any leftover socket.
    rmSync(pidPath, { force: true });
  }

  rmSync(socketPath, { force: true });
  writeFileSync(pidPath, String(process.pid));
}

async function main() {
  acquireSingleInstanceLock();

  const db = openDb();
  db.prepare("INSERT INTO daemon_startups (started_at) VALUES (?)").run(new Date().toISOString());

  const app = buildServer(db);
  await app.listen({ path: socketPath });
  console.log(`daemon listening on ${socketPath} (db: ${dbPath})`);

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    await app.close();
    db.close();
    rmSync(socketPath, { force: true });
    rmSync(pidPath, { force: true });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
