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
const AGY_PRE_INVOCATION_HOOK = join(PACKAGE_ROOT, "dist", "hooks", "agy-pre-invocation.js");
const AGY_STOP_HOOK = join(PACKAGE_ROOT, "dist", "hooks", "agy-stop.js");

// How long to give a freshly spawned session before concluding its
// SessionStart/PreInvocation hook never fired at all, rather than
// misflagging one that's simply still starting up.
const CONFIRM_GRACE_MS = 20_000;

// Adapters this module knows how to detect/fix missing hook wiring for —
// keyed by agent_adapter_name, same as the hardcoded check used to be.
// Widen this if a third adapter grows hook support.
const HOOKED_ADAPTERS = ["Claude", "Antigravity (agy)"] as const;

function buildHooksMissingMessage(adapterName: string): string {
  if (adapterName === "Antigravity (agy)") {
    const hooksJsonSnippet = JSON.stringify(
      {
        besiege: {
          PreInvocation: [{ type: "command", command: `node ${AGY_PRE_INVOCATION_HOOK}` }],
          Stop: [{ type: "command", command: `node ${AGY_STOP_HOOK}` }],
        },
      },
      null,
      2,
    );

    return [
      "In order for Besiege to work with Antigravity (agy), its PreInvocation/Stop hooks need to be " +
        "registered in agy's global hooks config on this machine. An agent or a user needs to add the " +
        'following to ~/.gemini/config/hooks.json (create the file with {} first if it doesn\'t exist; ' +
        "merge into it rather than overwriting, if it already has other named hooks):",
      "",
      "```json",
      hooksJsonSnippet,
      "```",
      "",
      "Note: agy's hook schema was reverse-engineered (no official reference was available) — if this " +
        "doesn't take effect, double-check the field names against `packages/daemon/README.md`'s " +
        '"Wiring Antigravity (agy) hooks" section.',
    ].join("\n");
  }

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
    "In order for Besiege to work, its SessionStart/Notification hooks need to be registered in Claude " +
      "Code's global config on this machine. An agent or a user needs to add the following to " +
      "~/.claude/settings.json (create the file with {} first if it doesn't exist; merge into any " +
      'existing "hooks" key rather than overwriting it):',
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
  agentAdapterName: string;
}

// Called on the same interval as expireStaleClaims (index.ts) — cheap
// no-op query when there's nothing overdue, which is the common case once
// hooks are actually working.
export function checkHookHealth(db: Database.Database): void {
  const cutoff = new Date(Date.now() - CONFIRM_GRACE_MS).toISOString();
  const offenders = db
    .prepare(
      `SELECT id, agent_session_id AS agentSessionId, cwd, agent_adapter_name AS agentAdapterName
       FROM terminal_sessions
       WHERE agent_adapter_name IN (${HOOKED_ADAPTERS.map(() => "?").join(", ")})
         AND agent_session_id IS NOT NULL
         AND hook_confirmed_at IS NULL
         AND hook_warning_sent_at IS NULL
         AND created_at < ?`,
    )
    .all(...HOOKED_ADAPTERS, cutoff) as HookOffenderRow[];

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
  ).run(first.agentSessionId, first.cwd, buildHooksMissingMessage(first.agentAdapterName), now);
}
