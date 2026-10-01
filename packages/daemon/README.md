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

## Fleet (several machines, one control plane)

Sessions run on the machine you start them from; what they are, where they
run, and everything else Besiege tracks lives on one always-on **control
plane**. Any client on any machine can attach to any session, and a
client with no compute of its own (a phone using the web UI) gets its
sessions placed on whichever machine has room.

Every client (GUI, web UI, hooks, MCP) still only talks to this machine's
own `daemon.sock`. In front of it a dispatcher (`src/dispatcher.ts`)
forwards requests to the control plane while it's reachable, and falls
back to this machine's own DB while it isn't. The two datasets are never
merged: sessions started during an outage stay in the local DB.

### Roles

- **Control plane** (the always-on box): holds the DB, receives
  heartbeats, runs the scheduler, and proxies terminal streams to whichever
  host runs each session. Only it needs `fleet.yaml`.
- **Host** (every other machine): runs its own daemon, which owns its PTYs
  and serves `/exec/*`. It sends the control plane a heartbeat every 5s: CPU
  load, available memory, and every PTY with its process tree's RSS/CPU.
- **Client**: anything that attaches. Clients never appear in config.

### Setup

On the control plane:

```bash
BESIEGE_HOST_ID=mac                # optional; defaults to the hostname, lowercased, without .local
BESIEGE_TCP_HOST=100.x.y.z         # its Tailscale IP
BESIEGE_TCP_PORT=4570
```

A random bearer token is generated on first run at
`$BESIEGE_STATE_DIR/tcp-token` (`chmod 600`). `cat` it to hand to the
hosts.

On every other host:

```bash
BESIEGE_HOST_ID=krukomp            # optional, as above
BESIEGE_PRIMARY_URL=http://100.x.y.z:4570
BESIEGE_PRIMARY_TOKEN=<control plane's tcp-token>
BESIEGE_TCP_HOST=100.a.b.c         # this host's own Tailscale IP, so the control plane can reach /exec/*
BESIEGE_TCP_PORT=4570
# BESIEGE_ADVERTISE_URL=http://...  # only if the URL others should use differs from TCP_HOST:TCP_PORT
```

A host's TCP listener accepts both its own token and the control plane's.
The control plane presents its own token when calling a host. Never bind
`BESIEGE_TCP_HOST` beyond your tailnet (no `0.0.0.0`, no port-forwarding).
The daemon executes arbitrary commands, and the token is defense in depth
on top of the Tailscale boundary, not a substitute for it.

### `fleet.yaml`

Lives at `$BESIEGE_STATE_DIR/fleet.yaml` on the control plane (override
with `BESIEGE_FLEET_CONFIG`). Changes are picked up on the next spawn
without a restart. A broken edit keeps the previous config, and the error
is reported by `GET /fleet/hosts`. See [`fleet.example.yaml`](fleet.example.yaml).
The code knows no machine by name: a host that heartbeats but isn't listed
gets `defaults`, and keys may be globs (`"kru*"`).

Without a `fleet.yaml` and with nobody heartbeating in, a daemon places
every session on itself, regardless of load, exactly as before fleets
existed.

### Placement

When a session is spawned, the scheduler tries each step of
`placement.order` until one gives it a host:

1. **origin**: the host the request came from (sent by its dispatcher),
   if it has capacity.
2. **pool**: the online host with the most headroom.
3. **wake**: every sleeping host with a `wake` method, woken in parallel.
   The session goes to the first one that heartbeats in with capacity
   within `wake_timeout`.
4. **last_resort**: a host with free `last_resort.slots`, regardless of
   load, with `last_resort.env`/`nice` applied to the session.

If every step fails, the spawn returns an error naming each host it
considered and why it couldn't be used.

A host **has capacity** if, with the session's estimated cost added, its
memory use and `load1 / cpus` both stay under `placement.limits`. That
estimate is the average peak RSS of the adapter's last 20 sessions, or
`default_cost` until there are at least 3 samples. Hosts with `pool: false`
are only ever used as a last resort.

A spawn request may pass `host` (force a host, still has to be online) or
`requires: [tag, ...]` (the host needs all those `tags`). Resuming a
session always pins it to its original host, because that's where the
agent CLI keeps its transcript.

Spawns answer within 3s. A placement that takes longer (waiting on a
woken host) carries on in the background with `placementStatus:
"placing"`, and the pane's stream shows its progress until it attaches.

### When hosts restart

- **The control plane restarts:** sessions on other hosts keep running and
  stay attached to their rows. Its own sessions behave as before (resumed
  after a crash).
- **A host crashes** (its next heartbeat carries a new boot id): the
  control plane resumes its resumable agent sessions on that same host,
  rewrites layouts to point at them, and posts a `fleet` notification.
- **A host shuts down cleanly:** it sends a final heartbeat first, so its
  sessions are recorded as ended rather than lost, and nothing is resumed.
- **A PTY no row owns any more** (killed while its host was unreachable)
  is killed by the control plane once its host's heartbeat shows it.

`GET /fleet/hosts` shows each host as `online`, `recovering` (silent for
less than `restart_grace`) or `offline`, along with its stats and session
count.

What isn't built yet (phone access, moving sessions between hosts,
sharing one session between several viewers, and more) is tracked in
[`docs/fleet-roadmap.md`](../../docs/fleet-roadmap.md).

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

## Wiring Antigravity (agy) hooks

agy has a structurally different hook system from Claude Code — no
`SessionStart`/`Notification` events with an `additionalContext`-style
output, but `hooks.json` lifecycle hooks (`PreToolUse`, `PostToolUse`,
`PreInvocation`, `PostInvocation`, `Stop`) that inject content via
`injectSteps`/`ephemeralMessage` instead. **This schema was
reverse-engineered** — cross-checked against literal strings in the
installed `agy` binary rather than an official reference, since none was
found — so treat it as a first pass to be corrected after real use, not a
confirmed contract.

Add to `~/.gemini/config/hooks.json` (global; `<workspace>/.agents/hooks.json`
for a single project) — merge into it rather than overwriting, if it
already has other named hooks:

```json
{
  "besiege": {
    "PreInvocation": [{ "type": "command", "command": "node /path/to/besiege/packages/daemon/dist/hooks/agy-pre-invocation.js" }],
    "Stop": [{ "type": "command", "command": "node /path/to/besiege/packages/daemon/dist/hooks/agy-stop.js" }]
  }
}
```

- `agy-pre-invocation.js` — agy's closest analog to `session-start.js`.
  Only acts on a conversation's first invocation (guessed from
  `invocationNum`, since agy has no dedicated session-start event of its
  own), resolves `workspacePaths[0]` against `config_rules`, and emits
  `injectSteps: [{ ephemeralMessage }]` instead of `additionalContext`.
- `agy-stop.js` — agy's closest analog to `notification.js`. agy's `Stop`
  event has no confirmed "genuinely idle vs. mid-turn" discriminator (a
  `fullyIdle`-style field some third-party docs claimed does not appear
  anywhere in the binary), so this currently fires on every `Stop` — likely
  noisier than Claude's `Notification` until that's confirmed one way or
  the other.

Besiege's own MCP server and the `--conversation`-based resume are handled
separately — see `agents.default.yaml`'s `mcpRegisterCommand` (a one-time
`agy mcp add` rather than a per-launch flag) and
`sessionIdFromWorkspaceCache` (agy has no way to pre-assign a conversation
id, so Besiege discovers it after launch from agy's own
`~/.gemini/antigravity-cli/cache/last_conversations.json`).

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
