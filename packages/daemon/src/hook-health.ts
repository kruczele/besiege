// Detects the SessionStart hook silently never firing for a Claude session
// — i.e. `packages/daemon/README.md`'s "Wiring Claude Code hooks" step was
// never done on this machine (or this project's .claude/settings.json) —
// and raises a system notification with a copy-paste-ready fix, instead of
// every session just silently missing its edicts context forever. Purely
// per-machine/per-project: a session on a different machine (or a project
// with its own settings.local.json) can be wired correctly even while this
// one isn't, so this only ever speaks to what it can actually observe here.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

// This module runs as either dist/hook-health.js (prod) or
// src/hook-health.ts (dev, under tsx watch) — import.meta.url differs
// between the two, so it is NOT a stable anchor for locating the built hook
// scripts. Going one directory up from wherever this file happens to live
// always lands on the daemon package root, from which dist/hooks/*.js — the
// built, runnable entry points, regardless of which mode the daemon itself
// is running under — is stable. Same technique as terminals.ts's
// MCP_ENTRY_POINT.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_START_HOOK = join(PACKAGE_ROOT, "dist", "hooks", "session-start.js");
const NOTIFICATION_HOOK = join(PACKAGE_ROOT, "dist", "hooks", "notification.js");

// How long to give a freshly spawned Claude session before concluding its
// SessionStart hook never fired at all, rather than misflagging one that's
// simply still starting up.
const CONFIRM_GRACE_MS = 20_000;

function buildHooksMissingMessage(): string {
  const settingsSnippet = JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `node ${SESSION_START_HOOK}` }] }],
        Notification: [{ hooks: [{ type: "command", command: `node ${NOTIFICATION_HOOK}` }] }],
      },
    },
    null,
    2,
  );

  return [
    "Besiege's Claude Code hooks aren't wired up on this machine (or this " +
      "project's .claude/settings.json) — edicts (config_rules context) and " +
      "the attention inbox's Notification relay won't reach any Claude " +
      "session here until they are. A session on a different machine, or a " +
      "different project's own settings.local.json, can be fine even while " +
      "this one isn't — this only reflects what this daemon can see.",
    "",
    "Paste this to an agent, or apply it yourself:",
    "",
    "Add the following to ~/.claude/settings.json — create the file with " +
      '{} first if it doesn\'t exist, and merge this into any existing ' +
      '"hooks" key rather than overwriting it:',
    "",
    "```json",
    settingsSnippet,
    "```",
  ].join("\n");
}

interface HookOffenderRow {
  id: number;
  agentSessionId: string;
  cwd: string;
}

// Called on the same interval as expireStaleClaims (index.ts) — cheap
// no-op query when there's nothing overdue, which is the common case once
// hooks are actually working.
export function checkHookHealth(db: Database.Database): void {
  const cutoff = new Date(Date.now() - CONFIRM_GRACE_MS).toISOString();
  const offenders = db
    .prepare(
      `SELECT id, agent_session_id AS agentSessionId, cwd FROM terminal_sessions
       WHERE agent_adapter_name = 'Claude'
         AND agent_session_id IS NOT NULL
         AND hook_confirmed_at IS NULL
         AND hook_warning_sent_at IS NULL
         AND created_at < ?`,
    )
    .all(cutoff) as HookOffenderRow[];

  if (offenders.length === 0) return;

  const now = new Date().toISOString();
  const markWarned = db.prepare("UPDATE terminal_sessions SET hook_warning_sent_at = ? WHERE id = ?");
  for (const offender of offenders) markWarned.run(now, offender.id);

  // One open warning is enough until the operator dismisses it — every
  // Claude session spawned while hooks are broken would otherwise queue up
  // its own identical copy in the inbox.
  const alreadyOpen = db
    .prepare("SELECT 1 FROM notifications WHERE kind = 'hooks-missing' AND acknowledged_at IS NULL")
    .get();
  if (alreadyOpen) return;

  const [first] = offenders;
  db.prepare(
    "INSERT INTO notifications (session_id, cwd, message, kind, created_at) VALUES (?, ?, ?, 'hooks-missing', ?)",
  ).run(first.agentSessionId, first.cwd, buildHooksMissingMessage(), now);
}
