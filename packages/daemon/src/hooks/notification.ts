// Claude Code Notification hook entrypoint. Fires when a session is idle
// and waiting on input; relays it to the daemon so it shows up in one
// place instead of requiring the operator to notice a specific terminal.
// Best-effort: never fails the hook if the daemon is unreachable.
//
// The hook itself is wired globally in ~/.claude/settings.json, so it fires
// for every Claude Code session on the machine — not just ones Besiege
// spawned. Gate on BESIEGE_SESSION_ID (set by terminals.ts/cli.ts on
// sessions Besiege actually launched) so unrelated sessions elsewhere don't
// pile up as noise in the Inbox.
import { postJson, readStdin } from "./client.js";

async function main() {
  if (!process.env.BESIEGE_SESSION_ID) return;

  const raw = await readStdin();

  let payload: { session_id?: string; cwd?: string; message?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = payload.session_id;
  const message = payload.message;
  if (!sessionId || !message) return;

  try {
    await postJson("/notifications", { sessionId, cwd: payload.cwd, message });
  } catch {
    // Daemon unreachable — drop it, don't fail the hook.
  }
}

main();
