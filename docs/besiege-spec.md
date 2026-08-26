# Besiege — Requirements & Architecture Spec

A daemon-backed console for running coding agents across multi-repo campaigns — config injection, campaign memory, and a PR tracking system that replaces GitHub's UI at fleet scale.

- **Status:** Draft, from design conversation
- **Owner:** Michal Krukowski
- **Date:** 2026-08-26

## Contents

1. [Problem & goals](#1-problem--goals)
2. [Non-goals](#2-non-goals)
3. [Architecture](#3-architecture)
4. [Config injection](#4-config-injection)
5. [Memory service](#5-memory-service)
6. [PR tracking](#6-pr-tracking)
7. [Claims & presence](#7-claims--presence)
8. [Attention inbox](#8-attention-inbox)
9. [Agent-facing interface](#9-agent-facing-interface)
10. [UI: GUI + TUI](#10-ui-gui--tui)
11. [Non-functional](#11-non-functional)
12. [Open questions](#12-open-questions)

## 1. Problem & goals

Org-wide rollouts (e.g. asdf → tool-versions) run as a multi-step PR flow — groundwork, migration, post-factum fixes, cleanup — across on the order of 300 repos. A single campaign can produce ~1,200 PRs. GitHub's PR list and Projects views are one-dimensional and choke at this scale; there is no view shaped like the actual work, which is a matrix of *repo × step*, not a list.

Separately, running many concurrent Claude Code sessions in terminals means: config/preferences live only in ad-hoc CLAUDE.md edits, nothing carries forward what a prior session already learned about a recurring failure, and knowing which of N terminals just asked a question means tab-hopping.

Goals:

- Centralize campaign state (PR status, review status, recurring failures) so agents and the operator both read from one place, refreshed on a schedule rather than queried live.
- Inject per-session config (always-on and path-scoped) without editing shared repo files.
- Carry forward what's been learned — both "how to do step X" and "how we fixed failure Y" — into subsequent sessions.
- Surface, in one place, every agent that's blocked on input or actively claimed on a PR, instead of N terminal tabs.
- Run as a native GUI on Ubuntu, and as a TUI with full functional parity for constrained/SSH contexts.

## 2. Non-goals

- Replacing GitHub as the system of record for code, reviews, or merges — Besiege caches and displays GitHub state, it doesn't own it.
- Fully autonomous dispatch. The operator initiates batches; claims are advisory rather than a hard scheduler lock (revisit if dispatch becomes automated).
- Blocking agents from using `gh` / the GitHub API outright — the internal representation is the preferred fast path for state, not the only permitted one.

## 3. Architecture

A local daemon is the single source of truth. The GUI and TUI are both thin clients over its API; the `besiege` CLI wrapper and Claude Code's own hooks are the integration seam into each session, rather than either front-end embedding orchestration logic directly.

```
 GUI (Ubuntu)      TUI              besiege CLI
 Electron/Tauri     SSH-friendly      wraps claude exec
        \                |                  /
         \_______________|_________________/
                          |
              local API (config resolve ·
           memory · PR cache · claims · inbox)
                          |
                       Daemon
         (SQLite-backed state · sole writer of cache)
                          |
     SessionStart / Notification hooks   |   scheduled GraphQL sync
                          |                                |
              Claude Code session                       GitHub
        (additionalContext injected,          (batched GraphQL poll,
              no file writes)                     interval-based)
```

The wrapper resolves the session's config from the daemon before `exec`-ing `claude`; delivery into the session happens via the `SessionStart` hook's `additionalContext` output, not a file write — see §4 for why that matters under concurrency.

## 4. Config injection

Rules are `{pattern, context}` pairs matched against session cwd and merged in match order — `*` is simply the trivial always-match case, not a special code path:

```yaml
# resolved and merged in order, not "most specific wins"
rules:
  - pattern: "*"
    context: "Always: conventional commits, never force-push."
  - pattern: "**/app-shedul*"
    context: "Legacy monolith — check CODEOWNERS before touching permissions."
  - pattern: "**/fresha-graphql*"
    context: "GraphQL is current standard, prefer it over REST."
```

**Delivery mechanism:** config is injected purely in-memory via the `SessionStart` hook's `additionalContext` JSON output — never written to CLAUDE.md/AGENTS.md. This was chosen over a write-then-cleanup wrapper specifically because worktree isolation is opt-in per agent, not automatic: any two sessions can share a cwd, and a shared config file is a collision surface no timing trick fully closes. A file-free hook output has no window to collide in, at any concurrency level.

## 5. Memory service

Two independently keyed stores, not one table — they differ in when they fire and how they're authored:

| Key | Trigger | Authored |
|---|---|---|
| `campaign × task-definition` | Every dispatch for that step, regardless of outcome | Up front, per pipeline step — a playbook entry |
| `campaign × failure-signature` | Only on retry-after-failure | Accumulates organically as agents hit new breakage |

A failure signature is deliberately not tied to a step — the same signature (e.g. a lint rule) can recur across the groundwork step in one repo and the cleanup step in another, and should resolve to the same documented fix either way.

## 6. PR tracking

The core of Besiege. The unit of work isn't a PR list, it's a matrix: `campaign → ordered steps → repos → PR`. At 300 repos × 4 steps, that's the view GitHub has no equivalent of.

### PR record

| Field | Description |
|---|---|
| `lifecycle` | not-started · open · approved · changes-requested · merged · closed |
| `ci` | passing / failing + which check + a pointer to a failure-signature record (not a copy of the failure) |
| `review` | approval state, plus unaddressed-feedback flag — distinct from changes-requested, since a PR can be approved with a dangling nit |
| `pending_tasks` | task-definition ids introduced after this PR existed, not yet confirmed applied |
| `claim` | see §7 — active-agent lease, if any |

### Retroactive tasks & batching

Task-definitions carry a `since` timestamp. A task added mid-rollout — e.g. "update the READMEs" discovered from review feedback after the first batch had already merged — becomes `pending` automatically on every PR that predates it, with no new PR batch required for repos that'll be touched again anyway.

Whenever an agent is dispatched to a PR for *any* reason, the daemon bundles the primary task plus all outstanding `pending_tasks` into the injected context: fixing a failing lint check becomes "fix the lint check; also apply the pending README update" — one CI run pays for both. Piggybacked work should land as its own commit within the PR, not folded into the primary diff, so it stays inspectable.

> **Completeness gap:** opportunistic batching only fires when a PR gets touched again for some other reason. A PR that's already merged and green will carry `pending_tasks` forever with nothing to trigger it. This needs a scheduled *campaign closeout* sweep — one pass over every repo with outstanding pending tasks, batched into a single new PR per repo — as the completeness backstop. Batching is the efficiency layer; the sweep is what guarantees the work actually finishes.

Completion isn't inferred from a diff — the agent reports back, in structured output at session end, exactly which `pending_tasks` ids it closed, and the daemon flips their state from that report.

### Sync engine

A background poller refreshes the cache on an interval using GitHub's GraphQL API with batched/aliased queries — at 1,200 PRs, one REST call per PR burns through rate limits fast. After an agent's own write (a push, a completion report), the daemon triggers a *targeted* resync of just that PR rather than waiting for the next interval, so a sibling agent touching a related repo minutes later doesn't act on stale pre-fix state.

## 7. Claims & presence

A lease, not a lock, attached to the PR record:

```
claim: {
  agent_id, session_id,
  note: "fixing README, tool-versions migration",
  claimed_at, heartbeat_at
}
```

Agents heartbeat their claim while working; the daemon clears a claim automatically after missed heartbeats. Without an expiry, a claim is a permanent lie the moment a session dies mid-work without releasing it — and at 300-repo scale, sessions will die.

**Advisory, not enforced** for now — a claim informs, it doesn't block a second agent from being dispatched to the same PR. Dispatch is human-initiated today; a dispatcher-level hard check only earns its cost once dispatch itself is automated.

## 8. Attention inbox

Claude Code's `Notification` hook fires when a session is idle and waiting on input; it posts to the daemon instead of relying on the operator noticing a specific terminal. A claim ("actively working, here's what") and a question ("blocked, need input") are two states of the same underlying board and should render together — not as separate views the operator has to reconcile.

## 9. Agent-facing interface

The internal representation is exposed to agents as an MCP tool — `pr_state(repo, campaign)`, `pending_tasks(repo)`, `failure_pattern(signature)` — paired with an always-on injected instruction to prefer it over raw `gh` / GitHub API calls for state reads, purely for rate-limit conservation at fleet scale.

This is a preference, not a restriction: agents still use `gh`/git directly for anything the cache doesn't hold — full diff content, PR descriptions, and all actual writes (pushing commits, opening PRs). The internal representation is the fast path for state, not a replacement for GitHub as the write target.

## 10. UI: GUI + TUI

Both front-ends are clients of the same daemon API — no orchestration logic lives in either. GUI trades for interaction flexibility; TUI trades for running anywhere (SSH, low resource) with full functional parity, not a reduced feature set.

- **Primary dashboard:** the campaign × step × repo grid — the view GitHub can't render, not a flat list.
- **Default filter — "needs me":** unaddressed review feedback, CI red with no matching failure signature (genuinely novel), or approved-and-mergeable. Passing / awaiting-review / matched-to-a-known-pattern-and-retried stays hidden by default.
- **Live status board:** active claims and open questions in one place, replacing tab-hopping across terminals.

## 11. Non-functional

- GitHub GraphQL batching is required at 1,200-PR scale — per-PR REST polling will hit rate limits.
- GUI must run natively on Ubuntu; TUI must work over a plain SSH session with no GUI dependencies.
- The daemon is the only process that talks to GitHub for state reads; front-ends and agents read the cache.

## 12. Open questions

- **Claim enforcement** — stays advisory while dispatch is human-initiated. Revisit if/when dispatch becomes automated and double-work risk rises.
- **GUI/TUI update model** — push updates from the daemon vs. poll-on-open/on-interval from each client — not yet decided.
- **Task-definition lifecycle** — how a task-definition itself gets authored and retired mid-campaign hasn't been specified — only that it carries a `since` marker.
- **Closed-campaign retention** — no pruning/archival policy yet for campaigns that have finished their closeout sweep.
