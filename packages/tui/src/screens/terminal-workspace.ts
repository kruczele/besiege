// Stage-4 walking skeleton: a single live pty pane per campaign, full-size.
// Splitting via daemon/layout-tree.ts (splitPane/closePane + a
// tree-to-boxes.ts geometry reconciler) is deferred to the next stage — this
// proves the vertical slice (session list/create -> WS attach -> render ->
// keystroke round-trip) before that novel geometry code is built on top.
import blessed from "neo-blessed";
import type { Widgets } from "blessed";
import { createTerminal, listTerminals } from "../daemon/terminals.js";
import { createPtyPane, type PtyPane } from "../terminal/pty-pane.js";

export interface TerminalWorkspace {
  box: Widgets.BoxElement;
  open(campaignId: number): Promise<void>;
}

export function createTerminalWorkspace(
  screen: Widgets.Screen,
  onLeave: () => void,
): TerminalWorkspace {
  const box = blessed.box({
    parent: screen,
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
  });

  let pane: PtyPane | undefined;

  async function open(campaignId: number): Promise<void> {
    pane?.destroy();
    pane = undefined;

    const sessions = await listTerminals(campaignId);
    const active = sessions.find((s) => s.status === "active");
    const session = active ?? (await createTerminal(campaignId, process.cwd()));

    pane = createPtyPane({
      parent: box,
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      sessionId: session.id,
      // Ctrl+B d: "leave" the workspace screen — a client-side view change
      // only. Sessions are daemon-owned and keep running regardless, unlike
      // tmux's own detach, which this deliberately does not try to imitate.
      onPrefixedKey: (key) => {
        if (key === "d") onLeave();
      },
    });
    pane.focus();
    screen.render();
  }

  return { box, open };
}
