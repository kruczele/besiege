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

## Remote peer (multi-machine setups, e.g. over Tailscale)

Every client (GUI, web UI, hooks) always talks to this machine's own
`daemon.sock` — that never changes. In front of it sits a small dispatcher
(`src/dispatcher.ts`) that can optionally forward everything through to
another machine's daemon instead of serving from this machine's own DB, so a
laptop's daemon can transparently defer to an always-on box's while it's
reachable, and fall back to its own local DB the moment it isn't. There's no
sync/merge of the two datasets — whichever one is currently being served is
the sole source of truth for that moment; data written locally while the
peer is unreachable stays local only.

- On the machine that should act as the shared source (the always-on box),
  set `BESIEGE_TCP_PORT` (and `BESIEGE_TCP_HOST`, typically that machine's
  Tailscale IP — there's no default beyond `127.0.0.1`, so exposure is
  opt-in and explicit). This also authenticates requests: a random bearer
  token is generated on first run and persisted to
  `$BESIEGE_STATE_DIR/tcp-token` (`chmod 600`) — `cat` it to hand to a peer.
  **The Tailscale network boundary alone is not treated as sufficient auth**
  — anything that can reach the TCP listener still needs the token, since
  the daemon can execute arbitrary shell commands.
- On a machine that should defer to that source, set `BESIEGE_PRIMARY_URL`
  (e.g. `http://100.x.y.z:4570`) and `BESIEGE_PRIMARY_TOKEN` (the value from
  the primary's `tcp-token` file). This machine keeps running its own local
  daemon/DB the whole time — it's just preferred over whenever the primary
  answers a `/health` check (polled every ~3s, short timeout, fails over
  immediately rather than waiting out the interval if a proxied request
  itself errors).
- Terminal sessions (PTYs) are spawned wherever the request actually lands —
  so while a follower is deferring to the primary, agent shells run and keep
  running on the primary/always-on box, not the follower.
- Never bind `BESIEGE_TCP_HOST` beyond your own tailnet (no `0.0.0.0`, no
  port-forwarding) — the token is defense in depth on top of the Tailscale
  boundary, not a substitute for it.

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
