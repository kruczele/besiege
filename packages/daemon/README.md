# daemon

Local process that's the single source of truth for Besiege — config
rules, the notification inbox, and (later) the PR/campaign tracking
cache. The GUI and TUI are thin clients over its HTTP API, served on a
unix socket rather than a TCP port (`$XDG_STATE_HOME/besiege/daemon.sock`,
override with `BESIEGE_STATE_DIR`).

## Run

```bash
pnpm --filter daemon dev     # tsx watch, restarts on change
pnpm --filter daemon build   # tsc -> dist/
pnpm --filter daemon start   # node dist/index.js
```

## Wiring Claude Code hooks

Config injection and the notification inbox are both driven by Claude
Code hooks pointed at the compiled scripts in `dist/hooks/`. Add to
`~/.claude/settings.json` (or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/besiege/packages/daemon/dist/hooks/session-start.js" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node /path/to/besiege/packages/daemon/dist/hooks/notification.js" }] }
    ]
  }
}
```

Both scripts read the hook's stdin JSON and talk to the daemon over
its unix socket — no network, no ports. Both fail open: if the daemon
isn't running, `session-start.js` prints `{}` (no context injected,
session starts normally) and `notification.js` silently drops the
event. Neither will ever block or fail a Claude Code session.

- `session-start.js` — resolves the session's `cwd` against
  `config_rules` and emits `additionalContext` for Claude Code to
  inject directly into the session. Nothing is ever written to
  CLAUDE.md/AGENTS.md, so concurrent sessions sharing a directory
  can't collide over it.
- `notification.js` — relays "waiting on your input" events into the
  daemon's `notifications` table so they show up in the GUI's Inbox
  tab instead of requiring you to notice a specific terminal.

## API

| Route | What |
|---|---|
| `GET /health` | process + DB liveness |
| `GET /config/rules` | list config rules |
| `POST /config/rules` | `{ pattern, context }` — create a rule |
| `DELETE /config/rules/:id` | remove a rule |
| `GET /config/resolve?cwd=` | merged context for a cwd, plus which rule ids matched |
| `GET /notifications?unacknowledged=true` | list, optionally filtered |
| `POST /notifications` | `{ sessionId, cwd, message }` — create |
| `POST /notifications/:id/ack` | mark acknowledged |

Config rule matching: patterns are plain globs (via `minimatch`)
against the session's `cwd`, matched in `id` (insertion) order and
concatenated — not "most specific wins". A bare `*` is special-cased
to always match, since real glob semantics never let a single `*` span
the `/` in a multi-segment path the way "always match" needs.
