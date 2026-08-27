import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentAdapter, Campaign, TerminalLayout, TerminalSession } from "../../shared/types.js";

const POLL_SESSIONS = 3000;

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
      unsubscribe();
      window.api.closeTerminalStream(id);
      term.dispose();
    };
  }, [id]);

  return <div className="terminal-viewport" ref={containerRef} />;
}

// A "meta-tab": renders every member session's terminal at once in a grid
// instead of one at a time. Column count grows with the square root of the
// pane count so 2 panes sit side by side, 4 form a 2x2, etc.
function GridView({
  layout,
  sessions,
  titles,
  onTitle,
  onRemove,
}: {
  layout: TerminalLayout;
  sessions: TerminalSession[];
  titles: Record<number, string>;
  onTitle: (id: number, title: string) => void;
  onRemove: (id: number) => void;
}) {
  const members = layout.sessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is TerminalSession => s !== undefined);

  if (members.length === 0) {
    return <p className="status status-pending main-empty">This meta-tab has no sessions yet — edit it to add some.</p>;
  }

  const columns = Math.ceil(Math.sqrt(members.length));

  return (
    <div className="terminal-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {members.map((s) => (
        <div key={s.id} className="terminal-grid-pane">
          <div className="terminal-grid-pane-header">
            <span className="terminal-grid-pane-title">{titles[s.id] ?? s.label ?? `Terminal #${s.id}`}</span>
            <button
              className="browser-tab-kill"
              title="Remove from this meta-tab"
              onClick={() => onRemove(s.id)}
            >
              ×
            </button>
          </div>
          <TerminalView id={s.id} onTitle={(title) => onTitle(s.id, title)} />
        </div>
      ))}
    </div>
  );
}

function LayoutForm({
  sessions,
  initialName,
  initialSessionIds,
  onSubmit,
  onCancel,
}: {
  sessions: TerminalSession[];
  initialName: string;
  initialSessionIds: number[];
  onSubmit: (name: string, sessionIds: number[]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<Set<number>>(new Set(initialSessionIds));

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <form
      className="rule-form layout-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit(name.trim(), [...selected]);
      }}
    >
      <input placeholder="Meta-tab name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <div className="layout-form-sessions">
        {sessions.length === 0 && <span className="empty-hint">No terminals open yet.</span>}
        {sessions.map((s) => (
          <label key={s.id} className="toggle layout-form-session">
            <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
            {s.label ?? `Terminal #${s.id}`}
          </label>
        ))}
      </div>
      <div className="layout-form-actions">
        <button type="submit">Save</button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function TerminalsMain({ campaignId }: { campaignId: number | null }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [adapters, setAdapters] = useState<AgentAdapter[]>([]);
  const [adapterId, setAdapterId] = useState<string>("");
  const [yolo, setYolo] = useState(false);
  const [extraArgs, setExtraArgs] = useState("");

  // Meta-tabs: null activeLayoutId means "plain single-session view" (the
  // pre-existing behavior); otherwise the main area renders that layout's
  // grid instead of a single TerminalView.
  const [layouts, setLayouts] = useState<TerminalLayout[]>([]);
  const [activeLayoutId, setActiveLayoutId] = useState<number | null>(null);
  const [layoutFormMode, setLayoutFormMode] = useState<"none" | "create" | number>("none");

  const reloadLayouts = (selectId?: number | null) => {
    if (campaignId === null) return;
    window.api.listLayouts(campaignId).then((res) => {
      if (res.ok) {
        setLayouts(res.result);
        if (selectId !== undefined) setActiveLayoutId(selectId);
      }
    });
  };

  useEffect(() => {
    setActiveLayoutId(null);
    setLayoutFormMode("none");
    if (campaignId === null) {
      setLayouts([]);
      return;
    }
    reloadLayouts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  const handleSaveLayout = async (name: string, sessionIds: number[]) => {
    if (campaignId === null) return;
    const res =
      typeof layoutFormMode === "number"
        ? await window.api.updateLayout(layoutFormMode, { name, sessionIds })
        : await window.api.createLayout(campaignId, name, sessionIds);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setLayoutFormMode("none");
    reloadLayouts(res.result.id);
  };

  const handleRemoveFromLayout = async (layout: TerminalLayout, sessionId: number) => {
    const res = await window.api.updateLayout(layout.id, {
      sessionIds: layout.sessionIds.filter((id) => id !== sessionId),
    });
    if (res.ok) reloadLayouts(layout.id);
  };

  const handleDeleteLayout = async (id: number) => {
    await window.api.deleteLayout(id);
    if (activeLayoutId === id) setActiveLayoutId(null);
    reloadLayouts();
  };

  const activeLayout = layouts.find((l) => l.id === activeLayoutId) ?? null;
  const editingLayout =
    typeof layoutFormMode === "number" ? (layouts.find((l) => l.id === layoutFormMode) ?? null) : null;

  useEffect(() => {
    window.api.listAgentAdapters().then((res) => {
      if (res.ok) setAdapters(res.result);
    });
  }, []);

  const selectedAdapter = adapters.find((a) => a.id === Number(adapterId));

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
    setSelectedId(null);
    if (campaignId === null) {
      setSessions([]);
      return;
    }
    let cancelled = false;

    const poll = async () => {
      const res = await window.api.listTerminals(campaignId);
      if (!cancelled && res.ok) {
        setSessions(res.result);
        setSelectedId((cur) => cur ?? res.result[0]?.id ?? null);
      }
    };

    poll();
    const t = setInterval(poll, POLL_SESSIONS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [campaignId]);

  const handleNew = async (e: React.FormEvent) => {
    e.preventDefault();
    if (campaignId === null) return;
    setError(null);
    if (!campaign?.defaultDir) {
      setError("This campaign has no default directory set — add one on the Campaigns tab first.");
      return;
    }
    const res = await window.api.createTerminal(
      campaignId,
      undefined,
      undefined,
      selectedAdapter?.id,
      selectedAdapter ? yolo : undefined,
      selectedAdapter && extraArgs.trim() ? extraArgs.trim() : undefined,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSessions((prev) => [res.result, ...prev]);
    setSelectedId(res.result.id);
    setYolo(false);
    setExtraArgs("");
  };

  const handleClose = async (id: number) => {
    await window.api.deleteTerminal(id);
    if (campaignId === null) return;
    const res = await window.api.listTerminals(campaignId);
    if (!res.ok) return;
    setSessions(res.result);
    setSelectedId((cur) => (cur === id ? (res.result[0]?.id ?? null) : cur));
    reloadLayouts();
  };

  if (campaignId === null) {
    return <p className="status status-pending main-empty">Select or create a campaign to open a terminal.</p>;
  }

  return (
    <div className="terminal-area">
      <div className="layout-tabs">
        <button
          className={`layout-tab ${activeLayoutId === null ? "selected" : ""}`}
          onClick={() => setActiveLayoutId(null)}
        >
          Single
        </button>
        {layouts.map((l) => (
          <div key={l.id} className={`layout-tab ${activeLayoutId === l.id ? "selected" : ""}`}>
            <span onClick={() => setActiveLayoutId(l.id)}>
              {l.name} ({l.sessionIds.length})
            </span>
            <button title="Edit meta-tab" onClick={() => setLayoutFormMode(l.id)}>
              ✎
            </button>
            <button title="Delete meta-tab" onClick={() => handleDeleteLayout(l.id)}>
              ×
            </button>
          </div>
        ))}
        <button className="layout-tab-new" title="New meta-tab" onClick={() => setLayoutFormMode("create")}>
          + grid
        </button>
      </div>

      {layoutFormMode !== "none" && (
        <LayoutForm
          key={typeof layoutFormMode === "number" ? layoutFormMode : "create"}
          sessions={sessions}
          initialName={editingLayout?.name ?? ""}
          initialSessionIds={editingLayout?.sessionIds ?? []}
          onSubmit={handleSaveLayout}
          onCancel={() => setLayoutFormMode("none")}
        />
      )}

      {activeLayoutId === null && (
        <div className="browser-tabs">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`browser-tab ${s.status === "active" ? "active" : "exited"} ${selectedId === s.id ? "selected" : ""}`}
              onClick={() => setSelectedId(s.id)}
            >
              <span className="browser-tab-dot" />
              <span className="browser-tab-title">{titles[s.id] ?? s.label ?? `Terminal #${s.id}`}</span>
              <button
                className="browser-tab-kill"
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose(s.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <form className="terminal-launcher" onSubmit={handleNew}>
            <select value={adapterId} onChange={(e) => setAdapterId(e.target.value)} title="Agent">
              <option value="">Shell</option>
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {selectedAdapter?.yoloFlag && (
              <label className="terminal-launcher-yolo" title={selectedAdapter.yoloFlag}>
                <input type="checkbox" checked={yolo} onChange={(e) => setYolo(e.target.checked)} />
                yolo
              </label>
            )}
            {selectedAdapter && (
              <input
                className="terminal-launcher-args"
                placeholder="extra args"
                value={extraArgs}
                onChange={(e) => setExtraArgs(e.target.value)}
              />
            )}
            <button type="submit" className="browser-tab-new" title="New terminal">
              +
            </button>
          </form>
        </div>
      )}

      {error && <p className="status status-down">{error}</p>}

      {activeLayout ? (
        <GridView
          layout={activeLayout}
          sessions={sessions}
          titles={titles}
          onTitle={(id, title) => setTitles((prev) => ({ ...prev, [id]: title }))}
          onRemove={(id) => handleRemoveFromLayout(activeLayout, id)}
        />
      ) : sessions.length === 0 ? (
        <p className="status status-pending main-empty">
          No terminals for {campaign?.name ?? "this campaign"} yet — click + to open one.
        </p>
      ) : (
        selectedId !== null && (
          <TerminalView
            key={selectedId}
            id={selectedId}
            onTitle={(title) => setTitles((prev) => ({ ...prev, [selectedId]: title }))}
          />
        )
      )}
    </div>
  );
}
