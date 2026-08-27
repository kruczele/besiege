import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Campaign, TerminalSession } from "../../shared/types.js";

const POLL_SESSIONS = 3000;

function TerminalView({ id }: { id: number }) {
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
      unsubscribe();
      window.api.closeTerminalStream(id);
      term.dispose();
    };
  }, [id]);

  return <div className="terminal-viewport" ref={containerRef} />;
}

export function TerminalsPanel() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.api.listCampaigns().then((res) => {
      if (res.ok && res.result.length > 0) {
        setCampaigns(res.result);
        setCampaignId(res.result[0].id);
      }
    });
  }, []);

  useEffect(() => {
    if (campaignId === null) return;
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

  const campaign = campaigns.find((c) => c.id === campaignId) ?? null;

  const handleNew = async () => {
    if (campaignId === null) return;
    setError(null);
    if (!campaign?.defaultDir) {
      setError("This campaign has no default directory set — edit it to add one before opening a terminal.");
      return;
    }
    const res = await window.api.createTerminal(campaignId, undefined, undefined);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSessions((prev) => [res.result, ...prev]);
    setSelectedId(res.result.id);
  };

  const handleKill = async (id: number) => {
    await window.api.killTerminal(id);
    const res = await window.api.listTerminals(campaignId!);
    if (res.ok) setSessions(res.result);
  };

  if (campaigns.length === 0) {
    return <p className="status status-pending">No campaigns yet — create one on the Campaigns tab first.</p>;
  }

  return (
    <div className="panel">
      <div className="campaign-toolbar">
        <select value={campaignId ?? ""} onChange={(e) => { setCampaignId(Number(e.target.value)); setSelectedId(null); }}>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button onClick={handleNew}>+ New terminal</button>
      </div>

      {error && <p className="status status-down">{error}</p>}

      <div className="terminal-tabs">
        {sessions.length === 0 && <p className="empty-hint">No terminals for this campaign yet.</p>}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`terminal-tab ${s.status === "active" ? "active" : "exited"} ${selectedId === s.id ? "selected" : ""}`}
            onClick={() => setSelectedId(s.id)}
          >
            <span>{s.label ?? `Terminal #${s.id}`}</span>
            <button
              className="terminal-tab-kill"
              onClick={(e) => {
                e.stopPropagation();
                handleKill(s.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {selectedId !== null && <TerminalView key={selectedId} id={selectedId} />}
    </div>
  );
}
