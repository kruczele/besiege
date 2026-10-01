# Fleet: what's built, what's next

The goal: run sessions on the machine that starts them, keep track of them
on one always-on control plane, and be able to sit down at any machine (or
a phone) and pick up any session. If the local machine is out of capacity,
run the session wherever there's room. If every work machine is down, the
control plane runs one session itself.

## Built

See the "Fleet" section of [`packages/daemon/README.md`](../packages/daemon/README.md).

- PTYs are hosted by `pty-host.ts` on each machine and exposed over a
  token-gated `/exec/*`. The control plane records each session's
  `host_id`/`exec_id`.
- Heartbeats every 5s carry load, available memory, and every PTY's
  process-tree RSS/CPU. The control plane reconciles rows from them: exits,
  lost PTYs, peak RSS, orphan reaping, and auto-resume on the same host
  after a crash.
- The scheduler reads one `fleet.yaml` and tries origin → pool → wake →
  last_resort, with tags, explicit `host`, resumes pinned to their host,
  in-flight slot accounting, and a capacity estimate from each adapter's
  history.
- Wake is either Wake-on-LAN or an arbitrary command, executed through a
  `via` host on the target's network.
- Terminal streams are proxied by the control plane, or attached locally
  when the viewer is on the session's own host.
- GUI panes show which host a session runs on.

## Still to build

Roughly in priority order.

### 1. Phone / web access to the control plane

The web UI (`packages/gui/src/web`) binds `127.0.0.1` and has no auth, so
it can't be used from a phone yet.

- Authenticate the web server before it is exposed to anything. Options:
  the control plane's token typed in once and kept in a cookie, or
  Tailscale identity headers via `tailscale serve`. Same reasoning as the
  daemon's TCP listener: the tailnet boundary alone isn't enough, because
  this executes arbitrary commands.
- `BESIEGE_WEB_HOST` to bind the tailnet IP, documented together with
  `tailscale serve` for HTTPS.
- A mobile layout: inbox first, a session list, and one terminal at a time.
- A plain prompt box that sends text plus Enter to the PTY, since typing
  into a full agent TUI on a phone keyboard is painful.
- Approve/deny buttons for agents blocked on permission prompts.

### 2. Several viewers on one session

- **Terminal size.** Today the PTY takes whichever resize arrived last,
  so two attached machines make it flip between window sizes. Size it by
  the most recently active viewer (tmux's `window-size latest`), and tell
  the others so they can letterbox.
- **Snapshot on attach.** Attaching replays a raw 200KB ring buffer, which
  draws a TUI badly at a different size and loses older output. Keep an
  `@xterm/headless` instance per PTY and send its serialized screen on
  attach.
- **Presence.** "Also attached from krukoffice" on the pane header.

### 3. Moving sessions between hosts

A PTY can't move between machines, but an agent conversation can.

- **Copy transcripts to the control plane.** After each turn, push the
  transcript (`~/.claude/projects/<slug>/<id>.jsonl`) to the control
  plane. This also makes a session's history readable while its host is
  off.
- **Push work in progress.** A WIP commit or ref pushed to the remote, so
  the destination host can rebuild the working tree.
- **A "move to host X" action:**
  1. Stop the session on its host if that host is reachable.
  2. Restore the transcript and the WIP state on X.
  3. Run `--resume` on X.
  4. Update the row's host so the pane follows.
- **Inbox suggestions.** "krukomp is back — move the mac's session there?"
  This frees the mac's last-resort slot, and also helps when a host is
  persistently overloaded.

### 4. Repo state on the chosen host

A session placed off its origin host gets the same `cwd` string, but that
host's checkout may be missing, behind, or not have the uncommitted
changes.

- Give each host a known repo root, and store `cwd` relative to it so
  differing home directories don't matter.
- Before placing remotely, check whether the origin's working tree is
  dirty and unpushed. Refuse, or push a WIP ref with the user's consent.
- Create a fresh worktree from the pushed branch on the destination,
  cloning on demand if the repo is missing.
- Let the scheduler skip hosts without the repo, as an automatic tag.

### 5. Sessions started while the control plane is unreachable

During an outage a follower serves its own DB, and sessions started then
never reach the control plane, so they're invisible from elsewhere.

- When the primary comes back, register sessions from the local DB with
  it: create rows with `host_id` set to this host. The PTYs already run
  here, so nothing needs to move.
- Inbox notifications and hook confirmations written locally during the
  outage need the same treatment: an outbox replayed to the control plane.

### 6. Daemon restarts shouldn't kill agents

A daemon restart still kills every PTY on that host. Auto-resume brings
agent conversations back, but the in-flight turn is lost. Move the PTYs
into a small, rarely-changing pty-host process (or `dtach`/`abduco`) that
outlives the daemon, which then reconnects to it on boot. This matters
most on hosts whose daemon gets upgraded often.

### 7. Smarter capacity

- Track CPU per adapter as well as memory (only RSS is learned today; CPU
  cost is the configured default).
- Watch memory pressure on the last-resort host. Under critical pressure,
  kill the session's heaviest children before the daemon is at risk, and
  say so in the inbox.
- Add hysteresis, so a host hovering at its limit doesn't flip between
  accepting and refusing.
- Log placement decisions so the limits can be tuned with data.

### 8. Fleet UI

- A hosts view built on `GET /fleet/hosts`: status, load and memory,
  sessions per host, `fleet.yaml` errors, and a manual wake button.
- An optional host picker in the pane launcher (`host` / `requires` on the
  spawn request already exist in the API).
- The TUI is unchanged so far. It ignores the new fields.

### 9. Second always-on box

- Copy the control plane's SQLite to the second box continuously
  (Litestream), so it can take over the registry and inbox without
  ending up with two diverged DBs.
- A documented failover runbook: promote the standby, then repoint every
  host's `BESIEGE_PRIMARY_URL` (or front both boxes with a stable
  Tailscale name).
