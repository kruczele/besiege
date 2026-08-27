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

The daemon is the single source of truth. The GUI and TUI are thin clients over its Unix socket API — no orchestration logic lives in either front-end.

## Packages

| Package | Description |
|---|---|
| [`packages/daemon`](packages/daemon) | HTTP API over a Unix socket, SQLite state, Claude Code hooks, GitHub sync |
| `packages/gui` | Electron app for Ubuntu — campaign grid, inbox, config UI |

## Getting started

```bash
pnpm install
pnpm dev:daemon   # daemon with hot reload
pnpm dev:gui      # Electron app
```

Wire Claude Code hooks from [`packages/daemon/README.md`](packages/daemon/README.md) to enable config injection and the notification inbox.

## Key features

- **Config injection** — per-session context rules resolved from the daemon and injected via `SessionStart` hook `additionalContext`. Never written to CLAUDE.md, so concurrent sessions sharing a cwd can't collide.
- **PR tracking** — campaign × step × repo matrix with lifecycle, CI, review state, and claim status. Backed by batched GitHub GraphQL polling (rate-limit safe at 1,200+ PRs).
- **Attention inbox** — `Notification` hook relays blocked/waiting sessions into a single board instead of requiring you to notice a specific terminal.
- **Campaign memory** — per-step playbooks and failure-signature records carried into subsequent sessions.
- **MCP interface** — `pr_state`, `pending_tasks`, `failure_pattern` tools exposed to agents as a fast-path alternative to raw `gh` calls.
