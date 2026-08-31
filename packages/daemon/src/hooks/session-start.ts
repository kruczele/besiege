// Claude Code SessionStart hook entrypoint. Reads the hook's stdin JSON,
// resolves this session's cwd against config_rules, and prints
// additionalContext for Claude Code to inject — no file ever written to
// CLAUDE.md/AGENTS.md, so concurrent sessions in the same directory
// can't collide over it. Fails open: any error here must never block
// a session from starting.
import { getJson, postJson, readStdin } from "./client.js";

async function main() {
  const raw = await readStdin();

  // Inherited from the pty this hook is running inside of (terminals.ts
  // spawnSession) — proof to the daemon that this session's SessionStart
  // hook actually fired, i.e. that Besiege's hooks are wired up on this
  // machine at all. See hook-health.ts for the other side of this check.
  // Fire-and-forget: never let this delay or block the actual hook output.
  const besiegeSessionId = process.env.BESIEGE_SESSION_ID;
  if (besiegeSessionId) {
    postJson(`/terminal-sessions/by-agent-session/${encodeURIComponent(besiegeSessionId)}/hook-confirm`, {}).catch(
      () => {},
    );
  }

  let cwd: string | undefined;
  try {
    cwd = JSON.parse(raw)?.cwd;
  } catch {
    // malformed input — nothing to resolve against
  }

  if (!cwd) {
    console.log("{}");
    return;
  }

  try {
    const besiegeSession = besiegeSessionId ? "1" : "0";
    const { context } = await getJson<{ context: string }>(
      `/config/resolve?cwd=${encodeURIComponent(cwd)}&besiegeSession=${besiegeSession}`,
    );
    if (!context) {
      console.log("{}");
      return;
    }
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
      }),
    );
  } catch {
    // Daemon unreachable — fail open rather than block the session.
    console.log("{}");
  }
}

main();
