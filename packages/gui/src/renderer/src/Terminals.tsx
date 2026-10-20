import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { Copy, GripVertical, LayoutGrid, PanelBottomOpen, PanelRightOpen, Plus, X } from "lucide-react";
import type {
  ActiveClaim,
  AgentAdapter,
  Campaign,
  PaneEditor,
  PaneNode,
  PaneNote,
  TerminalLayout,
  TerminalSession,
} from "../../shared/types.js";
import {
  appendLeaf,
  closePane,
  emptyTree,
  findLeaf,
  insertBeside,
  leavesInOrder,
  setPaneEditor,
  setPaneSession,
  setSizes,
  splitPane,
  type DropEdge,
} from "./pane-tree.js";

const POLL_SESSIONS = 3000;

// Monaco is several MB; terminal-only sessions never load it.
const EditorView = lazy(() => import("./Editor.js"));

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
      // The default (courier) lacks block-element glyphs like ▀ ▄ (agy's logo),
      // so they fall back to a font with a different advance and misalign.
      fontFamily: 'Menlo, "SF Mono", Monaco, Consolas, "DejaVu Sans Mono", monospace',
      theme: { background: "#1b1e27", foreground: "#e7e8ed" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Default handler opens via window.open, which Electron's
    // setWindowOpenHandler (main/index.ts) already routes to shell.openExternal.
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    // The WebGL renderer draws block/box characters itself instead of via
    // font glyphs. Optional: on failure or GPU context loss xterm falls back
    // to its DOM renderer.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {}
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
  hosts,
  defaultDir,
  onLaunch,
  onOpenEditor,
  resume,
}: {
  adapters: AgentAdapter[];
  // Online fleet machines to pick from; empty (no fleet) hides the picker.
  hosts: string[];
  // Pre-fills the editor's path prompt.
  defaultDir: string | null;
  onLaunch: (adapterName: string | undefined, yolo: boolean, extraArgs: string, host: string | undefined) => void;
  onOpenEditor: (editor: PaneEditor) => void;
  // Present when this pane's previous occupant exited but left behind a
  // resumable agent conversation (resume_flag + agent_session_id) — offers
  // continuing it instead of only falling back to a fresh shell/agent.
  resume?: { agentName: string; onResume: () => void };
}) {
  const [yolo, setYolo] = useState(false);
  const [extraArgs, setExtraArgs] = useState("");
  const [host, setHost] = useState("");
  const chosenHost = host || undefined;
  const [editorPath, setEditorPath] = useState<string | null>(null);

  const openEditor = () => {
    const path = editorPath?.trim();
    if (!path) return;
    // "Auto" has no meaning for a file: it lives on a specific machine, and
    // with no pick that is the daemon this GUI talks to.
    onOpenEditor({ host: chosenHost ?? null, path });
  };

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
        {hosts.length > 1 && (
          <select
            className="pane-launcher-host"
            title="Machine to run on — Auto lets the fleet pick the least loaded"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          >
            <option value="">Auto</option>
            {hosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        )}
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
        <button onClick={() => onLaunch(undefined, false, extraArgs, chosenHost)}>Shell</button>
        {adapters.map((a) => (
          <button key={a.name} onClick={() => onLaunch(a.name, yolo, extraArgs, chosenHost)}>
            {a.name}
          </button>
        ))}
        <button onClick={() => setEditorPath((cur) => cur ?? (defaultDir ? `${defaultDir.replace(/\/$/, "")}/` : ""))}>
          Editor
        </button>
      </div>
      {editorPath !== null && (
        <div className="pane-launcher-options">
          <input
            className="pane-launcher-args pane-launcher-path"
            autoFocus
            placeholder="/absolute/path/to/file"
            value={editorPath}
            onChange={(e) => setEditorPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") openEditor();
              if (e.key === "Escape") setEditorPath(null);
            }}
          />
          <button onClick={openEditor}>Open</button>
        </div>
      )}
    </div>
  );
}

// Short relative-age string ("3s", "5m", "2h 4m") — a local duplicate of
// App.tsx's elapsed(), kept separate rather than imported since App.tsx
// already imports this module (importing back would be circular).
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Above this many claimed PRs, an agent is doing bulk campaign work — a
// footer full of individual chips stops being a quick-glance aid and starts
// being clutter, so it collapses to a count instead.
const PINNED_PR_CHIP_LIMIT = 3;

// The PR(s) a pane's agent currently has claimed (claim_pr), pinned to the
// bottom of its own pane for one-click access — register_pr alone carries no
// agent attribution, so claims (which do carry the claiming session's id)
// are what let this be scoped per-agent rather than per-campaign.
function PinnedPrBar({ claims }: { claims: ActiveClaim[] }) {
  const openable = claims.filter((c) => c.githubPrNumber !== null);
  if (openable.length === 0) return null;

  if (openable.length > PINNED_PR_CHIP_LIMIT) {
    return (
      <div className="pane-pinned-prs">
        <span className="pane-pinned-pr-chip pane-pinned-pr-count">{openable.length} PRs</span>
      </div>
    );
  }

  return (
    <div className="pane-pinned-prs">
      {openable.map((c) => (
        <a
          key={c.id}
          className="pane-pinned-pr-chip"
          href={`https://github.com/${c.repoName}/pull/${c.githubPrNumber}`}
          target="_blank"
          rel="noreferrer"
          title={c.repoName}
        >
          {c.repoName.split("/").pop()}
          <span className="pane-pinned-pr-number">#{c.githubPrNumber}</span>
        </a>
      ))}
    </div>
  );
}

// A panel pinned by the pin_note MCP tool — plain, pre-wrapped text (not
// rendered markdown) so it shows exactly what the agent sent, with no new
// rendering dependency.
function NotePane({ note }: { note: PaneNote }) {
  return (
    <div className="pane-note">
      <div className="pane-note-meta">pinned {relativeTime(note.createdAt)} ago</div>
      <pre className="pane-note-content">{note.content}</pre>
    </div>
  );
}

// Present only while layout editing is on; `dragPaneId` is null until a pane
// header is actually picked up.
interface PaneDnd {
  dragPaneId: string | null;
  onDragStart: (paneId: string) => void;
  onDragEnd: () => void;
  onDrop: (targetPaneId: string, edge: DropEdge) => void;
}

function edgeAt(e: React.DragEvent<HTMLElement>): DropEdge {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const distances: [DropEdge, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  return distances.reduce((best, d) => (d[1] < best[1] ? d : best))[0];
}

// Covers a pane while another pane is being dragged, so the terminal under it
// can't swallow the drop; the nearest edge to the cursor picks where it lands.
function PaneDropOverlay({ onDrop }: { onDrop: (edge: DropEdge) => void }) {
  const [edge, setEdge] = useState<DropEdge | null>(null);
  return (
    <div
      className="pane-drop-overlay"
      onDragOver={(e) => {
        e.preventDefault();
        setEdge(edgeAt(e));
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(edgeAt(e));
        setEdge(null);
      }}
    >
      {edge && <div className={`pane-drop-zone pane-drop-zone-${edge}`} />}
    </div>
  );
}

// Recursively renders a PaneNode: a split becomes two flex children plus a
// draggable divider, a leaf becomes a live terminal pane, a pinned note
// panel, or (session null, note null) the launcher above.
function PaneView({
  node,
  sessions,
  titles,
  adapters,
  hosts,
  defaultDir,
  claimsBySessionId,
  activePaneId,
  dnd,
  onTitle,
  onActivate,
  onSplit,
  onClosePane,
  onLaunch,
  onOpenEditor,
  onResume,
  onSizesChange,
  onSizesCommit,
}: {
  node: PaneNode;
  sessions: TerminalSession[];
  titles: Record<number, string>;
  adapters: AgentAdapter[];
  hosts: string[];
  defaultDir: string | null;
  // Keyed by the agent's own session id (TerminalSession.agentSessionId,
  // what claim_pr attributes a claim to) — not the terminal id — so a pane
  // can look up its own agent's claims regardless of which terminal row
  // currently backs it (e.g. after a resume).
  claimsBySessionId: Record<string, ActiveClaim[]>;
  activePaneId: string | null;
  dnd: PaneDnd | null;
  onTitle: (id: number, title: string) => void;
  onActivate: (paneId: string) => void;
  onSplit: (paneId: string, dir: "row" | "col") => void;
  onClosePane: (paneId: string, sessionId?: number) => void;
  onLaunch: (
    paneId: string,
    adapterName: string | undefined,
    yolo: boolean,
    extraArgs: string,
    host: string | undefined,
  ) => void;
  onOpenEditor: (paneId: string, editor: PaneEditor) => void;
  onResume: (paneId: string, terminalId: number) => void;
  onSizesChange: (splitId: string, sizes: number[]) => void;
  onSizesCommit: (splitId: string, sizes: number[]) => void;
}) {
  if (node.type === "split") {
    return (
      <PaneSplitView
        node={node}
        sessions={sessions}
        titles={titles}
        adapters={adapters}
        hosts={hosts}
        defaultDir={defaultDir}
        claimsBySessionId={claimsBySessionId}
        activePaneId={activePaneId}
        dnd={dnd}
        onTitle={onTitle}
        onActivate={onActivate}
        onSplit={onSplit}
        onClosePane={onClosePane}
        onLaunch={onLaunch}
        onOpenEditor={onOpenEditor}
        onResume={onResume}
        onSizesChange={onSizesChange}
        onSizesCommit={onSizesCommit}
      />
    );
  }

  const session = node.sessionId !== null ? sessions.find((s) => s.id === node.sessionId) : undefined;
  const isActive = activePaneId === node.id;
  const isExited = session?.status === "exited";
  const adapter = session?.agentAdapterName != null ? adapters.find((a) => a.name === session.agentAdapterName) : undefined;
  const canResume = isExited && adapter?.resumeFlag != null && session?.agentSessionId != null;
  const pinnedClaims = session?.agentSessionId != null ? claimsBySessionId[session.agentSessionId] ?? [] : [];

  return (
    <div className={`terminal-grid-pane ${isActive ? "active" : ""}`} onMouseDownCapture={() => onActivate(node.id)}>
      <div
        className={`terminal-grid-pane-header ${dnd ? "draggable" : ""}`}
        draggable={dnd !== null}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.id);
          dnd?.onDragStart(node.id);
        }}
        onDragEnd={() => dnd?.onDragEnd()}
      >
        {dnd && <GripVertical size={13} className="terminal-grid-pane-grip" />}
        <span className={`terminal-grid-pane-title ${isExited ? "exited" : ""}`}>
          {node.note ? node.note.title : node.editor ? node.editor.path.split("/").pop() : session ? titles[session.id] ?? session.label ?? `Terminal #${session.id}` : "Empty"}
        </span>
        {session?.fleetPlaced && (
          <span className="terminal-grid-pane-host" title={session.placementNote ?? undefined}>
            {session.hostId}
          </span>
        )}
        <div className="terminal-grid-pane-actions">
          {node.note && (
            <button
              title="Copy pinned text"
              onClick={() => void navigator.clipboard.writeText(node.note!.content).catch(() => {})}
            >
              <Copy size={13} />
            </button>
          )}
          <button title="Split right" onClick={() => onSplit(node.id, "row")}>
            <PanelRightOpen size={13} />
          </button>
          <button title="Split down" onClick={() => onSplit(node.id, "col")}>
            <PanelBottomOpen size={13} />
          </button>
          <button title="Close pane" onClick={() => onClosePane(node.id, session?.id)}>
            <X size={13} />
          </button>
        </div>
      </div>
      {dnd && dnd.dragPaneId !== null && dnd.dragPaneId !== node.id && (
        <PaneDropOverlay onDrop={(edge) => dnd.onDrop(node.id, edge)} />
      )}
      {node.note ? (
        <NotePane note={node.note} />
      ) : node.editor ? (
        <Suspense fallback={<p className="status status-pending pane-loading">Loading editor…</p>}>
          <EditorView editor={node.editor} />
        </Suspense>
      ) : node.sessionId === null ? (
        <PaneLauncher
          adapters={adapters}
          hosts={hosts}
          defaultDir={defaultDir}
          onLaunch={(adapterName, yolo, extraArgs, host) => onLaunch(node.id, adapterName, yolo, extraArgs, host)}
          onOpenEditor={(editor) => onOpenEditor(node.id, editor)}
        />
      ) : !session ? (
        <p className="status status-pending pane-loading">Loading…</p>
      ) : isExited ? (
        // Falls back to a fresh launcher instead of sitting on a dead,
        // uninteractive terminal — with an option to pick up the same
        // agent conversation again when it's resumable.
        <PaneLauncher
          adapters={adapters}
          hosts={hosts}
          defaultDir={defaultDir}
          onLaunch={(adapterName, yolo, extraArgs, host) => onLaunch(node.id, adapterName, yolo, extraArgs, host)}
          onOpenEditor={(editor) => onOpenEditor(node.id, editor)}
          resume={canResume ? { agentName: adapter!.name, onResume: () => onResume(node.id, session.id) } : undefined}
        />
      ) : (
        <>
          <TerminalView id={session.id} onTitle={(title) => onTitle(session.id, title)} />
          <PinnedPrBar claims={pinnedClaims} />
        </>
      )}
    </div>
  );
}

// The minimum share (of the split's total) either side of a divider is
// allowed to shrink to while dragging.
const MIN_PANE_SIZE = 0.08;

function PaneSplitView(props: Parameters<typeof PaneView>[0] & { node: Extract<PaneNode, { type: "split" }> }) {
  const { node } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const isRow = node.dir === "row";

  // Dragging the divider between children[i] and children[i+1] only ever
  // trades size between those two neighbors — every other child's share
  // stays fixed, same as a tmux/VS Code split resize.
  const startDrag = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const before = node.sizes.slice(0, i).reduce((sum, s) => sum + s, 0);
    const span = node.sizes[i] + node.sizes[i + 1];
    let latestSizes = node.sizes;

    const onMove = (ev: MouseEvent) => {
      const pos = isRow ? ev.clientX - rect.left : ev.clientY - rect.top;
      const size = isRow ? rect.width : rect.height;
      const frac = Math.min(before + span - MIN_PANE_SIZE, Math.max(before + MIN_PANE_SIZE, pos / size));
      latestSizes = node.sizes.map((s, idx) => {
        if (idx === i) return frac - before;
        if (idx === i + 1) return before + span - frac;
        return s;
      });
      props.onSizesChange(node.id, latestSizes);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      props.onSizesCommit(node.id, latestSizes);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div ref={containerRef} className={`pane-split pane-split-${node.dir}`}>
      {node.children.flatMap((child, i) => [
        ...(i > 0
          ? [<div key={`divider-${child.id}`} className={`pane-divider pane-divider-${node.dir}`} onMouseDown={startDrag(i - 1)} />]
          : []),
        <div key={child.id} className="pane-split-child" style={{ flexBasis: `${node.sizes[i] * 100}%` }}>
          <PaneView {...props} node={child} />
        </div>,
      ])}
    </div>
  );
}

export function TerminalsMain({
  campaignId,
  focusRequest,
  onFocusHandled,
  titles,
  onTitleChange,
  onActiveSessionChange,
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
  // Lifted to App so the Inbox can auto-acknowledge a session's notification
  // once the operator has actually focused that pane for a while — the pane
  // tree only knows pane ids, not terminal session ids, so this is resolved
  // here and reported up rather than duplicated in App.
  onActiveSessionChange?: (sessionId: number | null) => void;
}) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [claims, setClaims] = useState<ActiveClaim[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adapters, setAdapters] = useState<AgentAdapter[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);

  // Every tab is a saved grid (a TerminalLayout) — there is no "single
  // session" view any more, so activeLayoutId is only ever null transiently
  // while a campaign's tabs are still loading.
  const [layouts, setLayouts] = useState<TerminalLayout[]>([]);
  const [activeLayoutId, setActiveLayoutId] = useState<number | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [renamingLayoutId, setRenamingLayoutId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [editingLayout, setEditingLayout] = useState(false);
  const [dragPaneId, setDragPaneId] = useState<string | null>(null);
  const [dropTabId, setDropTabId] = useState<number | null>(null);

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
    const load = () =>
      window.api.listFleet().then((res) => {
        if (res.ok) setHosts(res.result.hosts.filter((h) => h.status === "online").map((h) => h.hostId));
      });
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
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
      setClaims([]);
      return;
    }
    let cancelled = false;

    const poll = async () => {
      const [sessionsRes, claimsRes] = await Promise.all([
        window.api.listTerminals(campaignId),
        window.api.listCampaignClaims(campaignId),
      ]);
      if (cancelled) return;
      if (sessionsRes.ok) setSessions(sessionsRes.result);
      if (claimsRes.ok) setClaims(claimsRes.result);
    };

    poll();
    const t = setInterval(poll, POLL_SESSIONS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [campaignId]);

  // Regrouped only when the claims list itself changes — the pane tree
  // re-renders on every layouts poll tick regardless, but there's no reason
  // to rebuild this map on ticks where claims didn't move.
  const claimsBySessionId = useMemo(() => {
    const map: Record<string, ActiveClaim[]> = {};
    for (const c of claims) {
      (map[c.sessionId] ??= []).push(c);
    }
    return map;
  }, [claims]);

  const activeLayout = layouts.find((l) => l.id === activeLayoutId) ?? null;

  useEffect(() => {
    const activeLeaf = activeLayout ? leavesInOrder(activeLayout.tree).find((l) => l.id === activePaneId) : undefined;
    onActiveSessionChange?.(activeLeaf?.sessionId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLayout, activePaneId]);

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

  const handleLaunch = async (
    paneId: string,
    adapterName: string | undefined,
    yolo: boolean,
    extraArgs: string,
    host: string | undefined,
  ) => {
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
      host,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSessions((prev) => [res.result, ...prev]);
    persistTree(activeLayout.id, setPaneSession(activeLayout.tree, paneId, res.result.id));
  };

  const handleOpenEditor = (paneId: string, editor: PaneEditor) => {
    if (!activeLayout) return;
    persistTree(activeLayout.id, setPaneEditor(activeLayout.tree, paneId, editor));
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
      undefined,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSessions((prev) => [res.result, ...prev]);
    persistTree(activeLayout.id, setPaneSession(activeLayout.tree, paneId, res.result.id));
  };

  const handleSizesChange = (splitId: string, sizes: number[]) => {
    draggingRef.current = true;
    if (activeLayoutId === null) return;
    setLayouts((prev) => prev.map((l) => (l.id === activeLayoutId ? { ...l, tree: setSizes(l.tree, splitId, sizes) } : l)));
  };

  const handleSizesCommit = (splitId: string, sizes: number[]) => {
    draggingRef.current = false;
    const layout = layoutsRef.current.find((l) => l.id === activeLayoutId);
    if (!layout) return;
    persistTree(layout.id, setSizes(layout.tree, splitId, sizes));
  };

  const endDrag = () => {
    draggingRef.current = false;
    setDragPaneId(null);
    setDropTabId(null);
  };

  // The dragged pane's drop handlers run after it may already have been
  // re-parented (and its header unmounted), so dragend can't be relied on to
  // reset — every drop path calls endDrag itself.
  const handleDropPane = (targetPaneId: string, edge: DropEdge) => {
    const paneId = dragPaneId;
    endDrag();
    if (!activeLayout || paneId === null || paneId === targetPaneId) return;
    const leaf = findLeaf(activeLayout.tree, paneId);
    const rest = closePane(activeLayout.tree, paneId);
    if (!leaf || !rest) return;
    const tree = insertBeside(rest, targetPaneId, leaf, edge);
    if (!tree) return;
    persistTree(activeLayout.id, tree);
    setActivePaneId(paneId);
  };

  const handleDropOnTab = (layoutId: number) => {
    const paneId = dragPaneId;
    endDrag();
    const target = layouts.find((l) => l.id === layoutId);
    if (!activeLayout || paneId === null || !target || target.id === activeLayout.id) return;
    const leaf = findLeaf(activeLayout.tree, paneId);
    if (!leaf) return;
    // Target first: if the second write fails the pane is duplicated, not lost.
    persistTree(target.id, appendLeaf(target.tree, leaf));
    persistTree(activeLayout.id, closePane(activeLayout.tree, paneId) ?? emptyTree());
    if (activePaneId === paneId) setActivePaneId(null);
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
          <div
            key={l.id}
            className={`layout-tab ${activeLayoutId === l.id ? "selected" : ""} ${dropTabId === l.id ? "drop-target" : ""}`}
            onDragOver={(e) => {
              if (dragPaneId === null || l.id === activeLayoutId) return;
              e.preventDefault();
              setDropTabId(l.id);
            }}
            onDragLeave={() => setDropTabId((cur) => (cur === l.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              handleDropOnTab(l.id);
            }}
          >
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
        <button
          className={`layout-tab-edit ${editingLayout ? "active" : ""}`}
          title="Drag panes by their header to rearrange them, or onto another tab"
          onClick={() => {
            setEditingLayout((v) => !v);
            endDrag();
          }}
        >
          <LayoutGrid size={13} /> {editingLayout ? "Done" : "Edit layout"}
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
            hosts={hosts}
            defaultDir={campaign?.defaultDir ?? null}
            claimsBySessionId={claimsBySessionId}
            activePaneId={activePaneId}
            dnd={
              editingLayout
                ? {
                    dragPaneId,
                    onDragStart: (paneId) => {
                      draggingRef.current = true;
                      setDragPaneId(paneId);
                    },
                    onDragEnd: endDrag,
                    onDrop: handleDropPane,
                  }
                : null
            }
            onTitle={onTitleChange}
            onActivate={setActivePaneId}
            onSplit={handleSplit}
            onClosePane={handleClosePane}
            onLaunch={handleLaunch}
            onOpenEditor={handleOpenEditor}
            onResume={handleResume}
            onSizesChange={handleSizesChange}
            onSizesCommit={handleSizesCommit}
          />
        </div>
      ) : (
        <p className="status status-pending main-empty">Loading…</p>
      )}
    </div>
  );
}
