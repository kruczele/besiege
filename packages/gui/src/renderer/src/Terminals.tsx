import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { PanelBottomOpen, PanelRightOpen, Plus, X } from "lucide-react";
import type { AgentAdapter, Campaign, PaneNode, TerminalLayout, TerminalSession } from "../../shared/types.js";
import { closePane, emptyTree, leavesInOrder, setPaneSession, setRatio, splitPane } from "./pane-tree.js";

const POLL_SESSIONS = 3000;

// Reserved so the shell/agent inside a pane never sees these keystrokes —
// TerminalView's attachCustomKeyEventHandler blocks them from reaching the
// pty, and this same window-level listener (added by TerminalsMain) acts on
// them instead.
type ShortcutAction = "split-right" | "split-down" | "cycle-next" | "cycle-prev";

function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    if (e.key === "ArrowRight") return "split-right";
    if (e.key === "ArrowDown") return "split-down";
  }
  if (e.ctrlKey && e.altKey && !e.shiftKey) {
    if (e.key === "ArrowRight") return "cycle-next";
    if (e.key === "ArrowLeft") return "cycle-prev";
  }
  return null;
}

function TerminalView({ id, onTitle }: { id: number; onTitle: (title: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      theme: { background: "#1b1e27", foreground: "#e7e8ed" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    // Reserved pane-split/navigation combos must never reach the shell —
    // returning false here stops xterm from handling (and writing) them,
    // and the keydown event still bubbles to the window-level listener.
    // Ctrl+Shift+C is handled the same way, as an explicit copy shortcut
    // alongside the copy-on-select below (xterm has no clipboard integration
    // of its own — selecting text here otherwise does nothing).
    term.attachCustomKeyEventHandler((e) => {
      if (matchShortcut(e) !== null) return false;
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "c") {
        const selection = term.getSelection();
        if (selection) void navigator.clipboard.writeText(selection).catch(() => {});
        return false;
      }
      return true;
    });
    // Copy-on-select, like most terminal emulators — no explicit action
    // needed, selecting text is enough.
    const selectionSub = term.onSelectionChange(() => {
      const selection = term.getSelection();
      if (selection) void navigator.clipboard.writeText(selection).catch(() => {});
    });

    let disposed = false;
    const dataSub = term.onData((data) => {
      window.api.writeTerminal(id, data);
    });
    // Tabs rename themselves the way real terminal tabs do: shells and CLIs
    // (Claude Code included) set this via an OSC 0/2 title escape sequence.
    const titleSub = term.onTitleChange((title) => {
      if (title) onTitle(title);
    });

    const unsubscribe = window.api.attachTerminal(
      id,
      (chunk) => {
        if (!disposed) term.write(chunk);
      },
      (exitCode) => {
        if (!disposed) {
          term.write(`\r\n\x1b[90m[process exited${exitCode !== null ? ` with code ${exitCode}` : ""}]\x1b[0m\r\n`);
        }
      },
    );
    window.api.openTerminalStream(id);

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      window.api.resizeTerminal(id, term.cols, term.rows);
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataSub.dispose();
      titleSub.dispose();
      selectionSub.dispose();
      unsubscribe();
      window.api.closeTerminalStream(id);
      term.dispose();
    };
  }, [id]);

  return <div className="terminal-viewport" ref={containerRef} />;
}

// The button row shown inside an empty pane — direct one-click launch per
// agent instead of a dropdown + separate "go" step.
function PaneLauncher({
  adapters,
  onLaunch,
  resume,
}: {
  adapters: AgentAdapter[];
  onLaunch: (adapterName: string | undefined, yolo: boolean, extraArgs: string) => void;
  // Present when this pane's previous occupant exited but left behind a
  // resumable agent conversation (resume_flag + agent_session_id) — offers
  // continuing it instead of only falling back to a fresh shell/agent.
  resume?: { agentName: string; onResume: () => void };
}) {
  const [yolo, setYolo] = useState(false);
  const [extraArgs, setExtraArgs] = useState("");

  return (
    <div className="pane-launcher">
      {resume && (
        <div className="pane-launcher-resume">
          <button className="pane-launcher-resume-btn" onClick={resume.onResume}>
            Resume {resume.agentName}
          </button>
          <span className="pane-launcher-resume-hint">or start something new:</span>
        </div>
      )}
      <div className="pane-launcher-options">
        <input
          className="pane-launcher-args"
          placeholder="extra args"
          value={extraArgs}
          onChange={(e) => setExtraArgs(e.target.value)}
        />
        <button
          type="button"
          className={`pane-launcher-yolo ${yolo ? "active" : ""}`}
          title="Apply each agent's yolo/skip-permissions flag to the next launch"
          onClick={() => setYolo((v) => !v)}
        >
          YOLO
        </button>
      </div>
      <div className="pane-launcher-buttons">
        <button onClick={() => onLaunch(undefined, false, extraArgs)}>Shell</button>
        {adapters.map((a) => (
          <button key={a.name} onClick={() => onLaunch(a.name, yolo, extraArgs)}>
            {a.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// Recursively renders a PaneNode: a split becomes two flex children plus a
// draggable divider, a leaf becomes either a live terminal pane or (session
// null) the launcher above.
function PaneView({
  node,
  sessions,
  titles,
  adapters,
  activePaneId,
  onTitle,
  onActivate,
  onSplit,
  onClosePane,
  onLaunch,
  onResume,
  onRatioChange,
  onRatioCommit,
}: {
  node: PaneNode;
  sessions: TerminalSession[];
  titles: Record<number, string>;
  adapters: AgentAdapter[];
  activePaneId: string | null;
  onTitle: (id: number, title: string) => void;
  onActivate: (paneId: string) => void;
  onSplit: (paneId: string, dir: "row" | "col") => void;
  onClosePane: (paneId: string, sessionId?: number) => void;
  onLaunch: (paneId: string, adapterName: string | undefined, yolo: boolean, extraArgs: string) => void;
  onResume: (paneId: string, terminalId: number) => void;
  onRatioChange: (splitId: string, ratio: number) => void;
  onRatioCommit: (splitId: string, ratio: number) => void;
}) {
  if (node.type === "split") {
    return (
      <PaneSplitView
        node={node}
        sessions={sessions}
        titles={titles}
        adapters={adapters}
        activePaneId={activePaneId}
        onTitle={onTitle}
        onActivate={onActivate}
        onSplit={onSplit}
        onClosePane={onClosePane}
        onLaunch={onLaunch}
        onResume={onResume}
        onRatioChange={onRatioChange}
        onRatioCommit={onRatioCommit}
      />
    );
  }

  const session = node.sessionId !== null ? sessions.find((s) => s.id === node.sessionId) : undefined;
  const isActive = activePaneId === node.id;
  const isExited = session?.status === "exited";
  const adapter = session?.agentAdapterName != null ? adapters.find((a) => a.name === session.agentAdapterName) : undefined;
  const canResume = isExited && adapter?.resumeFlag != null && session?.agentSessionId != null;

  return (
    <div className={`terminal-grid-pane ${isActive ? "active" : ""}`} onMouseDownCapture={() => onActivate(node.id)}>
      {node.sessionId === null ? (
        <PaneLauncher adapters={adapters} onLaunch={(adapterName, yolo, extraArgs) => onLaunch(node.id, adapterName, yolo, extraArgs)} />
      ) : !session ? (
        <p className="status status-pending pane-loading">Loading…</p>
      ) : (
        <>
          <div className="terminal-grid-pane-header">
            <span className={`terminal-grid-pane-title ${isExited ? "exited" : ""}`}>
              {titles[session.id] ?? session.label ?? `Terminal #${session.id}`}
            </span>
            <div className="terminal-grid-pane-actions">
              <button title="Split right" onClick={() => onSplit(node.id, "row")}>
                <PanelRightOpen size={13} />
              </button>
              <button title="Split down" onClick={() => onSplit(node.id, "col")}>
                <PanelBottomOpen size={13} />
              </button>
              <button title="Close pane" onClick={() => onClosePane(node.id, session.id)}>
                <X size={13} />
              </button>
            </div>
          </div>
          {isExited ? (
            // Falls back to a fresh launcher instead of sitting on a dead,
            // uninteractive terminal — with an option to pick up the same
            // agent conversation again when it's resumable.
            <PaneLauncher
              adapters={adapters}
              onLaunch={(adapterName, yolo, extraArgs) => onLaunch(node.id, adapterName, yolo, extraArgs)}
              resume={canResume ? { agentName: adapter!.name, onResume: () => onResume(node.id, session.id) } : undefined}
            />
          ) : (
            <TerminalView id={session.id} onTitle={(title) => onTitle(session.id, title)} />
          )}
        </>
      )}
    </div>
  );
}

function PaneSplitView(props: Parameters<typeof PaneView>[0] & { node: Extract<PaneNode, { type: "split" }> }) {
  const { node } = props;
  const containerRef = useRef<HTMLDivElement>(null);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const isRow = node.dir === "row";
    let latestRatio = node.ratio;

    const onMove = (ev: MouseEvent) => {
      const pos = isRow ? ev.clientX - rect.left : ev.clientY - rect.top;
      const size = isRow ? rect.width : rect.height;
      latestRatio = Math.min(0.85, Math.max(0.15, pos / size));
      props.onRatioChange(node.id, latestRatio);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      props.onRatioCommit(node.id, latestRatio);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div ref={containerRef} className={`pane-split pane-split-${node.dir}`}>
      <div className="pane-split-child" style={{ flexBasis: `${node.ratio * 100}%` }}>
        <PaneView {...props} node={node.a} />
      </div>
      <div className={`pane-divider pane-divider-${node.dir}`} onMouseDown={startDrag} />
      <div className="pane-split-child" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>
        <PaneView {...props} node={node.b} />
      </div>
    </div>
  );
}

export function TerminalsMain({
  campaignId,
  focusRequest,
  onFocusHandled,
  titles,
  onTitleChange,
}: {
  campaignId: number | null;
  // Set by App (e.g. "Jump to agent" from the Inbox) to ask this campaign's
  // grid to switch to whichever tab/pane holds this terminal session, once
  // it's actually loaded. Cleared via onFocusHandled once acted on so it
  // doesn't keep re-triggering.
  focusRequest?: { campaignId: number; terminalId: number } | null;
  onFocusHandled?: () => void;
  // Lifted to App so the Army tab can also show a session's live title
  // (nicer than its adapter name/label) without duplicating this state.
  titles: Record<number, string>;
  onTitleChange: (id: number, title: string) => void;
}) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adapters, setAdapters] = useState<AgentAdapter[]>([]);

  // Every tab is a saved grid (a TerminalLayout) — there is no "single
  // session" view any more, so activeLayoutId is only ever null transiently
  // while a campaign's tabs are still loading.
  const [layouts, setLayouts] = useState<TerminalLayout[]>([]);
  const [activeLayoutId, setActiveLayoutId] = useState<number | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [renamingLayoutId, setRenamingLayoutId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const layoutsRef = useRef(layouts);
  useEffect(() => {
    layoutsRef.current = layouts;
  }, [layouts]);

  // Set while a divider drag is in progress, so the background layouts poll
  // doesn't fight the live (unpersisted-until-mouseup) ratio.
  const draggingRef = useRef(false);

  const reloadLayouts = async (selectId?: number) => {
    if (campaignId === null) return;
    const res = await window.api.listLayouts(campaignId);
    if (!res.ok) return;
    let list = res.result;
    if (list.length === 0) {
      const created = await window.api.createLayout(campaignId, "Tab 1", emptyTree());
      if (created.ok) list = [created.result];
    }
    setLayouts(list);
    setActiveLayoutId((cur) => {
      if (selectId !== undefined && list.some((l) => l.id === selectId)) return selectId;
      if (cur !== null && list.some((l) => l.id === cur)) return cur;
      return list[0]?.id ?? null;
    });
  };

  useEffect(() => {
    setActiveLayoutId(null);
    setActivePaneId(null);
    if (campaignId === null) {
      setLayouts([]);
      return;
    }
    reloadLayouts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  // Picks up server-side changes (chiefly: a daemon restart resuming agent
  // sessions under new ids and rewriting the tree to match).
  useEffect(() => {
    if (campaignId === null) return;
    const poll = async () => {
      if (draggingRef.current) return;
      const res = await window.api.listLayouts(campaignId);
      if (res.ok) setLayouts(res.result);
    };
    const t = setInterval(poll, POLL_SESSIONS);
    return () => clearInterval(t);
  }, [campaignId]);

  useEffect(() => {
    window.api.listAgentAdapters().then((res) => {
      if (res.ok) setAdapters(res.result);
    });
  }, []);

  useEffect(() => {
    if (campaignId === null) {
      setCampaign(null);
      return;
    }
    window.api.listCampaigns().then((res) => {
      if (res.ok) setCampaign(res.result.find((c) => c.id === campaignId) ?? null);
    });
  }, [campaignId]);

  useEffect(() => {
    if (campaignId === null) {
      setSessions([]);
      return;
    }
    let cancelled = false;

    const poll = async () => {
      const res = await window.api.listTerminals(campaignId);
      if (!cancelled && res.ok) setSessions(res.result);
    };

    poll();
    const t = setInterval(poll, POLL_SESSIONS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [campaignId]);

  const activeLayout = layouts.find((l) => l.id === activeLayoutId) ?? null;

  const persistTree = (layoutId: number, tree: PaneNode) => {
    setLayouts((prev) => prev.map((l) => (l.id === layoutId ? { ...l, tree } : l)));
    void window.api.updateLayout(layoutId, { tree });
  };

  const handleSplit = (paneId: string, dir: "row" | "col") => {
    if (!activeLayout) return;
    const result = splitPane(activeLayout.tree, paneId, dir);
    if (!result) return;
    persistTree(activeLayout.id, result.tree);
    setActivePaneId(result.newLeafId);
  };

  const handleClosePane = async (paneId: string, sessionId?: number) => {
    if (!activeLayout || campaignId === null) return;
    if (sessionId !== undefined) await window.api.deleteTerminal(sessionId);
    const collapsed = closePane(activeLayout.tree, paneId);
    persistTree(activeLayout.id, collapsed ?? emptyTree());
    if (activePaneId === paneId) setActivePaneId(null);
    const res = await window.api.listTerminals(campaignId);
    if (res.ok) setSessions(res.result);
  };

  const handleLaunch = async (paneId: string, adapterName: string | undefined, yolo: boolean, extraArgs: string) => {
    if (!activeLayout || campaignId === null) return;
    setError(null);
    if (!campaign?.defaultDir) {
      setError("This campaign has no default directory set — add one on the Campaigns tab first.");
      return;
    }
    const res = await window.api.createTerminal(
      campaignId,
      undefined,
      undefined,
      adapterName,
      adapterName ? yolo : undefined,
      adapterName && extraArgs.trim() ? extraArgs.trim() : undefined,
      undefined,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSessions((prev) => [res.result, ...prev]);
    persistTree(activeLayout.id, setPaneSession(activeLayout.tree, paneId, res.result.id));
  };

  // Manual counterpart to the daemon's boot-time auto-resume: relaunches the
  // same agent conversation (adapter/cwd/yolo/extraArgs all come from the
  // prior row server-side) from a pane whose agent process has exited.
  const handleResume = async (paneId: string, terminalId: number) => {
    if (!activeLayout || campaignId === null) return;
    setError(null);
    const res = await window.api.createTerminal(
      campaignId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      terminalId,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSessions((prev) => [res.result, ...prev]);
    persistTree(activeLayout.id, setPaneSession(activeLayout.tree, paneId, res.result.id));
  };

  const handleRatioChange = (splitId: string, ratio: number) => {
    draggingRef.current = true;
    if (activeLayoutId === null) return;
    setLayouts((prev) => prev.map((l) => (l.id === activeLayoutId ? { ...l, tree: setRatio(l.tree, splitId, ratio) } : l)));
  };

  const handleRatioCommit = (splitId: string, ratio: number) => {
    draggingRef.current = false;
    const layout = layoutsRef.current.find((l) => l.id === activeLayoutId);
    if (!layout) return;
    persistTree(layout.id, setRatio(layout.tree, splitId, ratio));
  };

  const handleNewTab = async () => {
    if (campaignId === null) return;
    const res = await window.api.createLayout(campaignId, `Tab ${layouts.length + 1}`, emptyTree());
    if (res.ok) {
      setLayouts((prev) => [...prev, res.result]);
      setActiveLayoutId(res.result.id);
      setActivePaneId(null);
    }
  };

  const handleDeleteLayout = async (id: number) => {
    if (campaignId === null) return;
    await window.api.deleteLayout(id);
    await reloadLayouts();
    setActivePaneId(null);
  };

  const displayName = (layout: TerminalLayout): string => {
    if (layout.isNameCustom) return layout.name;
    const firstFilled = leavesInOrder(layout.tree).find((l) => l.sessionId !== null);
    if (!firstFilled || firstFilled.sessionId === null) return layout.name;
    const session = sessions.find((s) => s.id === firstFilled.sessionId);
    return titles[firstFilled.sessionId] ?? session?.label ?? layout.name;
  };

  const startRename = (layout: TerminalLayout) => {
    setRenamingLayoutId(layout.id);
    setRenameValue(displayName(layout));
  };

  const commitRename = async () => {
    const id = renamingLayoutId;
    const value = renameValue.trim();
    setRenamingLayoutId(null);
    if (id === null || !value) return;
    const res = await window.api.updateLayout(id, { name: value, isNameCustom: true });
    if (res.ok) setLayouts((prev) => prev.map((l) => (l.id === id ? res.result : l)));
  };

  // Resolves a pending "jump to agent" request once this campaign's own
  // tabs have actually loaded — App sets campaignId first (so this
  // component even mounts for the right campaign), and this fires again
  // once `layouts` catches up.
  useEffect(() => {
    if (!focusRequest || focusRequest.campaignId !== campaignId) return;
    for (const layout of layouts) {
      const leaf = leavesInOrder(layout.tree).find((l) => l.sessionId === focusRequest.terminalId);
      if (leaf) {
        setActiveLayoutId(layout.id);
        setActivePaneId(leaf.id);
        onFocusHandled?.();
        return;
      }
    }
  }, [focusRequest, campaignId, layouts, onFocusHandled]);

  // Split/cycle shortcuts — TerminalView blocks these from reaching the
  // shell (attachCustomKeyEventHandler above), so they always land here.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = matchShortcut(e);
      if (!action || !activeLayout) return;
      if (action === "split-right" || action === "split-down") {
        if (!activePaneId) return;
        e.preventDefault();
        handleSplit(activePaneId, action === "split-right" ? "row" : "col");
      } else {
        e.preventDefault();
        const leaves = leavesInOrder(activeLayout.tree);
        if (leaves.length === 0) return;
        const idx = leaves.findIndex((l) => l.id === activePaneId);
        const delta = action === "cycle-next" ? 1 : -1;
        setActivePaneId(leaves[(idx === -1 ? 0 : idx + delta + leaves.length) % leaves.length].id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLayout, activePaneId]);

  if (campaignId === null) {
    return <p className="status status-pending main-empty">Select or create a campaign to open a terminal.</p>;
  }

  return (
    <div className="terminal-area">
      <div className="layout-tabs">
        {layouts.map((l) => (
          <div key={l.id} className={`layout-tab ${activeLayoutId === l.id ? "selected" : ""}`}>
            {renamingLayoutId === l.id ? (
              <input
                className="layout-tab-rename"
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenamingLayoutId(null);
                }}
              />
            ) : (
              <span
                onClick={() => {
                  setActiveLayoutId(l.id);
                  setActivePaneId(null);
                }}
                onDoubleClick={() => startRename(l)}
                title="Double-click to rename"
              >
                {displayName(l)}
              </span>
            )}
            <button title="Close tab" onClick={() => handleDeleteLayout(l.id)}>
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="layout-tab-new" title="New tab (split it with Ctrl+Shift+→/↓)" onClick={handleNewTab}>
          <Plus size={13} /> tab
        </button>
      </div>

      {error && <p className="status status-down">{error}</p>}

      {activeLayout ? (
        <div className="terminal-grid">
          <PaneView
            node={activeLayout.tree}
            sessions={sessions}
            titles={titles}
            adapters={adapters}
            activePaneId={activePaneId}
            onTitle={onTitleChange}
            onActivate={setActivePaneId}
            onSplit={handleSplit}
            onClosePane={handleClosePane}
            onLaunch={handleLaunch}
            onResume={handleResume}
            onRatioChange={handleRatioChange}
            onRatioCommit={handleRatioCommit}
          />
        </div>
      ) : (
        <p className="status status-pending main-empty">Loading…</p>
      )}
    </div>
  );
}
