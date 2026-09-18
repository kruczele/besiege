# Besiege

Besiege is a command center for coding agents — terminals, agent sessions, notes, repos, and pull requests, all grouped around the work you're actually doing, with one place to see what needs your attention instead of hunting across terminals and GitHub.

See [`docs/besiege-spec.md`](docs/besiege-spec.md) for the full requirements and architecture spec.

## The model: campaign → tabs → panels

A **campaign** is a container for everything belonging to one piece of work — one migration across 300 repos, one feature spanning five services, a dozen agents working in parallel. It holds:

- **Tabs**, each a saved grid layout of **panels**.
- A panel is either an **agent session**, a **terminal session**, or a **note** — for context you're dissecting and don't want to keep scrolling back to find.
- **Pinned repos**, and a **PR board** that tracks every pull request touching them.

```
Campaign
├─ Tab: "backend"
│   ├─ Panel: agent session (packages/api)
│   ├─ Panel: terminal
│   └─ Panel: note — rollout checklist
├─ Tab: "frontend"
│   └─ Panel: agent session (packages/web)
├─ Pinned repos
└─ PR board (branch × CI × review)
```

Each session is hardwired to its panel — restart your machine, and everything is exactly where you left it, one click from resumed. No re-finding which terminal was doing what.

## Why: the actual problem

Running many agents at once, across many repos, breaks down in a few specific ways:

- **Work has no home.** A terminal tab is not a unit of work — it dies with the window and tells you nothing about what it was for.
- **Context doesn't survive.** Config and preferences live in ad-hoc CLAUDE.md edits; nothing carries forward what a prior session already learned about a recurring failure.
- **Attention is unscoped.** Knowing which of N terminals just asked a question means tab-hopping; knowing which of your PRs need you means opening GitHub over and over.

Besiege isn't really managing the agents — it's managing *your* context and attention while the agents manage the code.

### The scale case

This started from an org-wide rollout across ~300 repos producing ~1,200 PRs. GitHub's PR list and Projects views are one-dimensional and choke at that scale — there's no view shaped like the actual work. Besiege's PR board groups by branch first (a campaign usually pushes the same branch name everywhere), then by CI and review status, so "this branch is still failing CI somewhere" is one glance instead of a hundred tabs. It stays in sync with GitHub on a schedule via batched GraphQL, so both you and your agents read from one fast, already-fresh place instead of each agent hitting the GitHub API on its own — which, at this scale, is not just slower, it's a different order of magnitude slower.

## Key features

- **Campaigns** — tabs of panels (agent sessions, terminals, notes), pinned repos, and a PR board, all scoped to one piece of work and recoverable after a restart.
- **Edicts** — your own path-scoped instructions for how agents should behave under a directory glob, injected into each session via the `SessionStart` hook. They travel with you personally and never touch a shared `CLAUDE.md`/`AGENTS.md`, so they can't collide with a teammate's session in the same repo.
- **PR board** — every PR touching a pinned repo, grouped by branch, then CI and review state. Backed by batched GitHub GraphQL polling, rate-limit-safe at 1,200+ PRs.
- **Inbox** — agent sessions that are blocked, waiting, or done relay into one board instead of requiring you to notice a specific terminal.
- **Campaign memory** — per-step playbooks and failure-signature records carried into subsequent sessions.
- **MCP interface** — `pr_state`, `pending_tasks`, `failure_pattern`, and claim tools exposed to agents as a fast-path alternative to raw `gh` calls — the same question that takes three round-trips through the GitHub API is one call here.

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
| `packages/tui` | Terminal UI — **early-stage spike**, not wired into the root `pnpm dev` scripts. See [Status](#status). |

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

## Status

This is a working daemon + GUI, actively evolving — not a finished product. Some of what the spec describes isn't built yet, and a few things that are built are intentionally provisional. Called out explicitly rather than left for you to discover:

- **No campaign closeout sweep.** A task added to a step after some of its PRs already merged only becomes `pending` on those PRs opportunistically — if the PR never gets touched again for an unrelated reason, that pending task just sits there forever. The scheduled sweep needed to actually guarantee completion (see [`docs/besiege-spec.md`](docs/besiege-spec.md#6-pr-tracking)) doesn't exist yet.
- **CI failure → memory linkage is half-wired.** Failure-signature records work fine on their own (create/lookup via the `failure_pattern` MCP tool), but the PR record's `ci_failure_signature_id` column — meant to point a failing PR at the matching signature automatically — isn't set by any code path yet. The two systems don't talk to each other yet.
- **Claims are advisory, not enforced.** Nothing stops a second agent from being dispatched to a PR someone else already claimed. Deliberate for now (dispatch is human-initiated), but worth knowing before you assume it's a safety net.
- **TUI (`packages/tui`) is an early-stage spike**, not at "full functional parity" with the GUI the spec calls for, and not wired into the root `pnpm dev`/`pnpm dev:*` scripts. Its own code notes that PTY pane full-screen rendering hasn't actually been verified against a live terminal yet.
- **Antigravity (`agy`) hook support was reverse-engineered** from the installed binary, not an official schema — treat it as a first pass likely to need correction, not a confirmed contract. Details and specific unknowns in [`packages/daemon/README.md`](packages/daemon/README.md#wiring-antigravity-agy-hooks).
- **GUI/TUI update model is still undecided** — push from the daemon vs. each client polling on an interval. Currently polling; not settled as the long-term answer.

If something looks unfinished, check [`docs/besiege-spec.md`](docs/besiege-spec.md)'s "Open questions" section first — several of these are known and deliberate, not oversights.
