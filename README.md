# Besiege

A daemon-backed console for running coding agents across multi-repo campaigns — config injection, campaign memory, and PR tracking at fleet scale.

See [`docs/besiege-spec.md`](docs/besiege-spec.md) for the full requirements and architecture spec.

## What it is

Org-wide rollouts across hundreds of repos produce thousands of PRs. GitHub's PR list and Projects views are one-dimensional and choke at this scale. Besiege's primary view is a **campaign × step × repo matrix** — the shape GitHub can't render.

On top of that: running many concurrent Claude Code sessions in terminals means config preferences live in ad-hoc CLAUDE.md edits, nothing carries forward what a prior session learned about a recurring failure, and knowing which of N terminals just asked a question requires tab-hopping. Besiege fixes all of that from a single place.

## Architecture

```
 GUI (Electron)    TUI              besiege CLI
       \             |                  /
        \___________|_________________/
                     |
         local API (config · memory · PR cache · inbox)
                     |
                  Daemon
      (SQLite-backed state · sole GitHub writer)
                     |
   SessionStart / Notification hooks  |  scheduled GraphQL sync
                     |                                |
         Claude Code session                       GitHub
   (additionalContext injected,          (batched GraphQL poll,
         no file writes)                     interval-based)
```

The daemon is the single source of truth. The GUI, its web UI, and the TUI are all thin clients over its Unix socket API — no orchestration logic lives in any front-end.

Each machine's daemon can optionally defer to another machine's over the
network (e.g. a laptop preferring an always-on box's daemon over Tailscale
when it's reachable, falling back to its own local DB otherwise) — see
[`packages/daemon`](packages/daemon)'s "Remote peer" section. This is
transparent to every client above: they always just talk to their own
machine's Unix socket.

## Packages

| Package | Description |
|---|---|
| [`packages/daemon`](packages/daemon) | HTTP API over a Unix socket, SQLite state, Claude Code hooks, GitHub sync |
| `packages/gui` | Electron app for Ubuntu — campaign grid, inbox, config UI. Also ships a browser-based alternative (`src/web`) that reuses the same UI over HTTP/WebSocket instead of Electron IPC. |

## Getting started

```bash
pnpm install
pnpm dev:daemon   # daemon with hot reload
pnpm dev:gui      # Electron app
```

### Web UI (alternative to the Electron app)

Same UI, reachable from an ordinary browser instead of the Electron window.

```bash
pnpm web
```

One-shot convenience command: starts a daemon if none is already running (leaves an already-running one alone — restarting it would kill any live agent terminal sessions it's tracking), builds the web UI, serves it on `http://127.0.0.1:4571`, and prints the URL. Ctrl+C stops the web server only.

If you need the daemon restarted on latest source (e.g. after a daemon-side change, or if it wasn't running via `tsx watch`), use `pnpm daemon:reload` — this **does** end any live agent terminal sessions the daemon was tracking.

For active development on the web UI itself (rebuild on save), run in three terminals instead:

```bash
pnpm dev:daemon      # daemon with hot reload
pnpm dev:webclient   # builds the browser bundle, rebuilds on change
pnpm dev:webserver   # serves it + proxies to the daemon, on http://127.0.0.1:4571
```

The web server binds to `127.0.0.1` only and has **no authentication** — it grants shell/agent command execution to whoever can reach it, so it must never be exposed beyond localhost (e.g. don't port-forward it, don't bind it to `0.0.0.0`).

Wire Claude Code hooks from [`packages/daemon/README.md`](packages/daemon/README.md) to enable config injection and the notification inbox.

## Key features

- **Config injection** — per-session context rules resolved from the daemon and injected via `SessionStart` hook `additionalContext`. Never written to CLAUDE.md, so concurrent sessions sharing a cwd can't collide.
- **PR tracking** — campaign × step × repo matrix with lifecycle, CI, review state, and claim status. Backed by batched GitHub GraphQL polling (rate-limit safe at 1,200+ PRs).
- **Attention inbox** — `Notification` hook relays blocked/waiting sessions into a single board instead of requiring you to notice a specific terminal.
- **Campaign memory** — per-step playbooks and failure-signature records carried into subsequent sessions.
- **MCP interface** — `pr_state`, `pending_tasks`, `failure_pattern` tools exposed to agents as a fast-path alternative to raw `gh` calls.
