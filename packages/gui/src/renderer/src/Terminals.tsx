import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentAdapter, Campaign, TerminalSession } from "../../shared/types.js";

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
  };

  if (campaignId === null) {
    return <p className="status status-pending main-empty">Select or create a campaign to open a terminal.</p>;
  }

  return (
    <div className="terminal-area">
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

      {error && <p className="status status-down">{error}</p>}

      {sessions.length === 0 ? (
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
