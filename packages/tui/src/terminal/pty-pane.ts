// Wires a daemon-owned pty (streamed over WS, see pty-client.ts) into a
// blessed `terminal` widget.
//
// Resolved (by reading neo-blessed's lib/widgets/terminal.js directly, not
// guessed): passing a `handler` option makes Terminal.bootstrap() return
// before it ever forks its own local pty.js process (see the `if
// (this.handler) return;` guard right before the `pty.js.fork(...)` call) —
// so this widget never owns a local shell. Terminal.prototype.write(data)
// (`this.term.write(data)`) feeds bytes straight into the embedded term.js
// emulator, independent of that pty-ownership branch — exactly the "externally
// fed bytes" entry point the plan needed. `handler` itself is our keystroke
// hook: whatever the user types gets handed to `handler(data)` instead of a
// local pty.
//
// NOT yet empirically verified (needs a human to actually look at a live
// pane): whether the resulting terminal-in-a-terminal renders full-screen
// programs (vim, htop, a nested agent CLI) correctly, and how well mouse
// events translate inside a nested split — neo-blessed's own source (line
// ~125 of terminal.js) warns "Cannot pass mouse events - coordinates will be
// off!", which matches the risk flagged in the plan.
//
// @types/blessed has no typings for the `terminal` widget at all, hence the
// `any` casts below — this is a real gap, not sloppiness.
import blessed from "neo-blessed";
import { attachPty, type PtyConnection } from "./pty-client.js";

const PREFIX_KEY = "\x02"; // Ctrl+B, tmux's own default prefix

export interface PtyPaneOptions {
  parent: unknown;
  left: string | number;
  top: string | number;
  width: string | number;
  height: string | number;
  sessionId: number;
  // Called for the single key following the Ctrl+B prefix, instead of that
  // key being forwarded to the pty. Keeps the prefix scheme's dispatch table
  // out of this file — callers (workspace-screen) decide what "d"/"%"/etc. do.
  onPrefixedKey?: (key: string) => void;
}

export interface PtyPane {
  el: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- untyped neo-blessed terminal widget
  focus(): void;
  destroy(): void;
}

export function createPtyPane(opts: PtyPaneOptions): PtyPane {
  let conn: PtyConnection | undefined;

  const label = ` session ${opts.sessionId} `;

  // The terminal widget listens on screen.program.input directly while
  // focused (see terminal.js line ~126), which bypasses blessed's normal
  // screen.key()/box.key() dispatch entirely — so the Ctrl+B prefix scheme
  // has to be intercepted right here, not via a keybinding on some parent
  // box, or it would never fire while a pane has focus.
  let awaitingPrefixedKey = false;

  const term = (blessed as any).terminal({
    parent: opts.parent,
    left: opts.left,
    top: opts.top,
    width: opts.width,
    height: opts.height,
    border: "line",
    label,
    tags: false,
    // No `shell`/`args` here on purpose — passing `handler` short-circuits
    // neo-blessed's own local pty spawn (see file header comment above).
    handler: (data: string) => {
      if (awaitingPrefixedKey) {
        awaitingPrefixedKey = false;
        opts.onPrefixedKey?.(data);
        return;
      }
      if (data === PREFIX_KEY) {
        awaitingPrefixedKey = true;
        return;
      }
      conn?.write(data);
    },
  });

  conn = attachPty(opts.sessionId);
  conn.onData((chunk) => term.write(chunk));
  conn.onExit((code) => {
    term.setLabel(`${label}(exited ${code ?? "?"}) `);
    term.screen.render();
  });
  conn.onError(() => {
    term.setLabel(`${label}(disconnected) `);
    term.screen.render();
  });

  term.on("resize", () => {
    const cols = term.width - term.iwidth;
    const rows = term.height - term.iheight;
    conn?.resize(cols, rows);
  });

  term.on("destroy", () => conn?.close());

  return {
    el: term,
    focus: () => term.focus(),
    destroy: () => term.destroy(),
  };
}
