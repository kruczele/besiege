---
name: run-gui
description: Build, run, and drive the GUI Electron app (packages/gui). Use when asked to start the GUI, take a screenshot of it, build it, or interact with its UI.
---

The GUI is an Electron app that shows the daemon's connection status
(more views land on top of this as the daemon grows features). For
agent/automated use, drive it via the Playwright REPL at
`.claude/skills/run-gui/driver.mjs` under xvfb.

All paths below are relative to `packages/gui/`.

## Prerequisites

The daemon (`packages/daemon`) must be running first, or the GUI will
correctly show "Daemon unreachable" instead of live data:

```bash
pnpm --filter daemon dev &
```

## Build

```bash
pnpm install   # from repo root
pnpm --filter gui build
```

## Run (agent path)

```bash
cd packages/gui
xvfb-run -a node .claude/skills/run-gui/driver.mjs
```

Wrap in tmux for interactive use:

```bash
tmux new-session -d -s gui -x 200 -y 50
tmux send-keys -t gui 'cd packages/gui' Enter
tmux send-keys -t gui 'xvfb-run -a node .claude/skills/run-gui/driver.mjs' Enter
timeout 15 bash -c 'until tmux capture-pane -t gui -p | tail -3 | grep -q "driver>"; do sleep 0.3; done'
tmux send-keys -t gui 'launch' Enter
timeout 20 bash -c 'until tmux capture-pane -t gui -p | tail -3 | grep -q "launched"; do sleep 0.3; done'
tmux send-keys -t gui 'ss status' Enter
tmux capture-pane -t gui -p
```

Screenshots land in `/tmp/shots/` (override: `SCREENSHOT_DIR`).

### Commands

| command | what it does |
|---|---|
| `launch` | launch the app, wait for the window |
| `ss [name]` | screenshot -> `/tmp/shots/<name>.png` |
| `text [css-sel]` | print innerText (omit selector for whole body) |
| `click-text <text>` | click a button/link containing this text |
| `wait <css-sel>` | wait for element, 10s timeout |
| `windows` | list all windows (single-window app today) |
| `quit` | close app, exit |

## Run (human path)

```bash
pnpm --filter gui dev   # opens a real window; useless headless
```

## Gotchas

- **`pnpm install` silently skips native/binary-download install
  scripts** (better-sqlite3, esbuild, and electron's own Chromium
  download) unless approved in `pnpm-workspace.yaml`'s `allowBuilds`.
  If `node_modules/electron/dist/` is missing, that's why — check
  `allowBuilds` has `electron: true` and reinstall.
- **electron-vite can't resolve `electron/package.json` when electron
  is only a devDependency of `packages/gui`** under pnpm's isolated
  node_modules — its own version-detection code walks up from deep
  inside the `.pnpm` store and never reaches `packages/gui/node_modules`.
  Fix in this repo: `electron` is also installed at the workspace root
  (`pnpm add -w -D electron`) so it resolves directly from root
  `node_modules`. `public-hoist-pattern` in `.npmrc` did *not* fix this
  in this pnpm version — don't bother re-trying it.
- **Don't `rm -rf node_modules` while a `tsx watch` daemon is running**
  — its file watcher sees dependency files vanish mid-reinstall, tries
  to restart, and crashes with a stale/missing module error. Stop dev
  processes before wiping `node_modules`.

## Troubleshooting

- **Launch timeout (30s):** build output missing? -> `pnpm --filter gui build`.
- **"Missing X server":** forgot `xvfb-run`. Headless Linux needs it.
- **GUI shows "Daemon unreachable":** the daemon isn't running, or its
  socket path (`$XDG_STATE_HOME/besiege/daemon.sock`, override
  via `BESIEGE_STATE_DIR`) doesn't match what the GUI resolved — check
  `packages/gui/src/main/daemon-paths.ts` and
  `packages/daemon/src/paths.ts` agree.
