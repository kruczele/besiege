// Claude Code SessionStart hook entrypoint. Reads the hook's stdin JSON,
// resolves this session's cwd against config_rules, and prints
// additionalContext for Claude Code to inject — no file ever written to
// CLAUDE.md/AGENTS.md, so concurrent sessions in the same directory
// can't collide over it. Fails open: any error here must never block
// a session from starting.
import { getJson, readStdin } from "./client.js";

async function main() {
  const raw = await readStdin();

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
    const { context } = await getJson<{ context: string }>(
      `/config/resolve?cwd=${encodeURIComponent(cwd)}`,
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
