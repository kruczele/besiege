// Antigravity (agy) Stop hook entrypoint — agy's closest analog to Claude
// Code's Notification hook. Unlike Notification, agy's Stop payload has no
// confirmed "genuinely idle vs. mid-multi-step-execution" discriminator (a
// third-party writeup claimed a `fullyIdle` boolean; it isn't present as a
// literal string anywhere in the agy binary, so it's not trusted here) —
// this fires on every Stop, which may be noisier than Claude's Notification
// until that's confirmed one way or the other against real behavior.
// Gated on BESIEGE_SESSION_ID so only Besiege-launched sessions post here.
// Best-effort: never fails the hook if the daemon is unreachable.
import { postJson, readStdin } from "./client.js";

interface AgyStopInput {
  conversationId?: string;
  terminationReason?: string;
  error?: string;
  workspacePaths?: string[];
}

async function main() {
  const besiegeSessionId = process.env.BESIEGE_SESSION_ID;
  if (!besiegeSessionId) return;

  const raw = await readStdin();

  let payload: AgyStopInput;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const message = payload.error
    ? `Antigravity session stopped with an error: ${payload.error}`
    : payload.terminationReason
      ? `Antigravity session idle: ${payload.terminationReason}`
      : "Antigravity session idle, waiting for input";

  try {
    await postJson("/notifications", {
      sessionId: besiegeSessionId,
      cwd: payload.workspacePaths?.[0],
      message,
    });
  } catch {
    // Daemon unreachable — drop it, don't fail the hook.
  }
}

main();
