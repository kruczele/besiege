// Antigravity (agy) PreInvocation hook entrypoint — agy's closest analog to
// Claude Code's SessionStart. agy has no additionalContext-style output;
// content is injected via injectSteps/ephemeralMessage instead (both
// confirmed as literal strings in the agy binary — Claude's own field
// names, additionalContext/hookSpecificOutput, are not present in it, so
// this is not the same contract, just an equivalent one). Only acts on a
// conversation's first invocation so config isn't re-injected every turn —
// the exact starting value of invocationNum (0 or 1) is a guess pending a
// live test; adjust here if the first real run shows it's off by one.
// Fails open: any error here must never block a turn from proceeding.
import { getJson, postJson, readStdin } from "./client.js";

interface AgyPreInvocationInput {
  invocationNum?: number;
  workspacePaths?: string[];
}

async function main() {
  const raw = await readStdin();

  // Same proof-of-wiring signal as session-start.ts, see hook-health.ts.
  const besiegeSessionId = process.env.BESIEGE_SESSION_ID;
  if (besiegeSessionId) {
    postJson(`/terminal-sessions/by-agent-session/${encodeURIComponent(besiegeSessionId)}/hook-confirm`, {}).catch(
      () => {},
    );
  }

  let input: AgyPreInvocationInput;
  try {
    input = JSON.parse(raw);
  } catch {
    console.log("{}");
    return;
  }

  // Whether invocationNum starts at 0 or 1 is unconfirmed, so treat either
  // as "first turn" and only skip once it's unambiguously past both.
  if (input.invocationNum !== undefined && input.invocationNum > 1) {
    console.log("{}");
    return;
  }

  const cwd = input.workspacePaths?.[0];
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
    console.log(JSON.stringify({ injectSteps: [{ ephemeralMessage: context }] }));
  } catch {
    // Daemon unreachable — fail open rather than block the turn.
    console.log("{}");
  }
}

main();
