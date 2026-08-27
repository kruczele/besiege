import { useEffect, useState } from "react";
import type {
  ActiveClaim,
  AgentAdapter,
  Campaign,
  CampaignStep,
  ConfigRule,
  DaemonHealth,
  DaemonResult,
  Notification,
  PrGridRow,
} from "../../shared/types.js";
import { TerminalsMain } from "./Terminals.js";

const POLL_FAST = 3000;
const POLL_GRID = 5000;

type Tab = "campaigns" | "live" | "rules" | "agents" | "inbox";

export function App() {
  const [tab, setTab] = useState<Tab>("campaigns");
  // The campaign currently in focus — set by CampaignsPanel's selector, read
  // by the main terminal area so "new terminal" knows which campaign it
  // belongs to. Terminals are children of campaigns, so there's one shared
  // notion of "current campaign" across the sidebar and the terminal area.
  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(null);

  // No application menu (frame: false, no visible menu bar) supplies the
  // conventional Ctrl/Cmd +/- zoom accelerators, so handle them here.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        window.api.zoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        window.api.zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        window.api.zoomReset();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="app-frame">
      <TitleBar />
      <div className="shell">
        <aside className="sidebar">
          <h1>Besiege</h1>
          <nav className="tabs">
            {(["campaigns", "live", "rules", "agents", "inbox"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </nav>
          <div className="sidebar-content">
            {tab === "campaigns" && (
              <CampaignsPanel activeCampaignId={activeCampaignId} onSelectCampaign={setActiveCampaignId} />
            )}
            {tab === "live" && <LivePanel />}
            {tab === "rules" && <RulesPanel />}
            {tab === "agents" && <AgentsPanel />}
            {tab === "inbox" && <InboxPanel />}
          </div>
          <div className="sidebar-footer">
            <StatusPanel />
          </div>
        </aside>
        <main className="main">
          <TerminalsMain campaignId={activeCampaignId} />
        </main>
      </div>
    </div>
  );
}

// ── Title bar ─────────────────────────────────────────────────────────────────

function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    window.api.isWindowMaximized().then(setMaximized);
    return window.api.onWindowMaximizeChanged(setMaximized);
  }, []);

  return (
    <div className="title-bar">
      <span className="title-bar-label">Besiege</span>
      <div className="title-bar-controls">
        <button
          className="title-bar-btn"
          aria-label="Minimize"
          onClick={() => window.api.minimizeWindow()}
        >
          &#x2013;
        </button>
        <button
          className="title-bar-btn"
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={() => window.api.toggleMaximizeWindow()}
        >
          {maximized ? "❐" : "❑"}
        </button>
        <button
          className="title-bar-btn title-bar-btn-close"
          aria-label="Close"
          onClick={() => window.api.closeWindow()}
        >
          &#x2715;
        </button>
      </div>
    </div>
  );
}

// ── Status ────────────────────────────────────────────────────────────────────

function StatusPanel() {
  const [result, setResult] = useState<DaemonResult<DaemonHealth> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const next = await window.api.getDaemonHealth();
      if (!cancelled) setResult(next);
    };
    poll();
    const id = setInterval(poll, POLL_FAST);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (result === null) return <p className="status status-pending">Checking daemon…</p>;
  if (!result.ok) return <p className="status status-down">Daemon unreachable — {result.error}</p>;

  return (
    <p className="status status-up" title={`Startups recorded: ${result.result.db.startupCount}`}>
      Daemon connected — pid {result.result.pid}, up {result.result.uptimeSeconds}s
    </p>
  );
}

// ── Campaign grid ─────────────────────────────────────────────────────────────

function lcClass(lifecycle: string) {
  const map: Record<string, string> = {
    "not-started": "lc-not-started",
    open: "lc-open",
    approved: "lc-approved",
    merged: "lc-merged",
    closed: "lc-closed",
    "changes-requested": "lc-changes-requested",
  };
  return `lc ${map[lifecycle] ?? "lc-not-started"}`;
}

function ciClass(ciStatus: string) {
  if (ciStatus === "failing") return "ci-failing";
  if (ciStatus === "passing") return "ci-passing";
  return "";
}

function elapsed(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function NewCampaignForm({ onCreated }: { onCreated: (c: Campaign) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultDir, setDefaultDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const res = await window.api.createCampaign(name, description || undefined, defaultDir.trim() || undefined);
    setCreating(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setName("");
    setDescription("");
    setDefaultDir("");
    onCreated(res.result);
  };

  return (
    <form className="rule-form new-campaign-form" onSubmit={submit}>
      <input placeholder="Campaign name" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <input
        placeholder="Default directory (optional)"
        value={defaultDir}
        onChange={(e) => setDefaultDir(e.target.value)}
      />
      {error && <p className="status status-down">{error}</p>}
      <button type="submit" disabled={creating || !name.trim()}>
        {creating ? "Creating…" : "Create campaign"}
      </button>
    </form>
  );
}

function CampaignsPanel({
  activeCampaignId,
  onSelectCampaign,
}: {
  activeCampaignId: number | null;
  onSelectCampaign: (id: number) => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const selectedId = activeCampaignId;
  const [steps, setSteps] = useState<CampaignStep[]>([]);
  const [prs, setPrs] = useState<PrGridRow[]>([]);
  const [needsMe, setNeedsMe] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);

  const reloadCampaigns = (selectId?: number) => {
    window.api.listCampaigns().then((res) => {
      if (res.ok) {
        setCampaigns(res.result);
        if (selectId !== undefined) onSelectCampaign(selectId);
        else if (res.result.length > 0 && selectedId === null) onSelectCampaign(res.result[0].id);
      }
    });
  };

  useEffect(() => {
    reloadCampaigns();
  }, []);

  const handleCreated = (c: Campaign) => {
    setShowNewForm(false);
    reloadCampaigns(c.id);
  };

  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;

    const load = async () => {
      const [stepsRes, prsRes] = await Promise.all([
        window.api.listSteps(selectedId),
        window.api.listCampaignPrs(selectedId, needsMe),
      ]);
      if (cancelled) return;
      if (stepsRes.ok) setSteps(stepsRes.result);
      if (prsRes.ok) setPrs(prsRes.result);
    };

    load();
    const id = setInterval(load, POLL_GRID);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedId, needsMe]);

  const handleSync = async () => {
    if (selectedId === null) return;
    setSyncing(true);
    await window.api.syncCampaign(selectedId);
    setTimeout(() => setSyncing(false), 1500);
  };

  // Build repo list + lookup: "repoName::stepId" → PrGridRow
  const repos = Array.from(new Set(prs.map((p) => p.repoName))).sort();
  const prIndex = new Map<string, PrGridRow>();
  for (const p of prs) prIndex.set(`${p.repoName}::${p.stepId}`, p);

  if (campaigns.length === 0) {
    return (
      <div className="panel">
        <p className="status status-pending">No campaigns yet.</p>
        <NewCampaignForm onCreated={handleCreated} />
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="campaign-toolbar">
        <select
          value={selectedId ?? ""}
          onChange={(e) => onSelectCampaign(Number(e.target.value))}
        >
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="toggle">
          <input
            type="checkbox"
            checked={needsMe}
            onChange={(e) => setNeedsMe(e.target.checked)}
          />
          Needs me
        </label>
        <button onClick={handleSync} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync GitHub"}
        </button>
        <button onClick={() => setShowNewForm((v) => !v)}>
          {showNewForm ? "Cancel" : "+ New Campaign"}
        </button>
      </div>

      {showNewForm && <NewCampaignForm onCreated={handleCreated} />}

      {repos.length === 0 ? (
        <p className="status status-pending">
          {needsMe ? "Nothing needs attention." : "No PRs registered yet."}
        </p>
      ) : (
        <div className="campaign-grid-wrap">
          <table className="campaign-grid">
            <thead>
              <tr>
                <th>Repo</th>
                {steps.map((s) => (
                  <th key={s.id}>{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <tr key={repo}>
                  <td className="repo-name">{repo}</td>
                  {steps.map((step) => {
                    const pr = prIndex.get(`${repo}::${step.id}`);
                    if (!pr) return <td key={step.id} />;
                    return (
                      <td key={step.id} className={ciClass(pr.ciStatus)}>
                        <div className="pr-cell">
                          <span className={lcClass(pr.lifecycle)}>{pr.lifecycle}</span>
                          {pr.ciStatus === "failing" && pr.ciCheckName && (
                            <span style={{ fontSize: "0.7rem", color: "#e5645a" }}>
                              ✕ {pr.ciCheckName}
                            </span>
                          )}
                          {pr.pendingTasksCount > 0 && (
                            <span className="pending-badge">+{pr.pendingTasksCount} pending</span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Live board ────────────────────────────────────────────────────────────────

function LivePanel() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [claims, setClaims] = useState<ActiveClaim[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    window.api.listCampaigns().then((res) => {
      if (res.ok && res.result.length > 0) {
        setCampaigns(res.result);
        setSelectedId(res.result[0].id);
      }
    });
  }, []);

  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;

    const poll = async () => {
      const [claimsRes, notifRes] = await Promise.all([
        window.api.listCampaignClaims(selectedId),
        window.api.listNotifications(true),
      ]);
      if (cancelled) return;
      if (claimsRes.ok) setClaims(claimsRes.result);
      if (notifRes.ok) setNotifications(notifRes.result);
    };

    poll();
    const id = setInterval(poll, POLL_FAST);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedId]);

  const ack = async (id: number) => {
    await window.api.acknowledgeNotification(id);
    const res = await window.api.listNotifications(true);
    if (res.ok) setNotifications(res.result);
  };

  return (
    <div className="panel">
      {campaigns.length > 1 && (
        <div className="campaign-toolbar">
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(Number(e.target.value))}
          >
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="live-board">
        <div className="live-section">
          <h2>Active agents</h2>
          {claims.length === 0 ? (
            <p className="empty-hint">No agents running.</p>
          ) : (
            <ul className="claim-list">
              {claims.map((c) => (
                <li key={c.id} className="claim-card">
                  <div className="c-repo">{c.repoName}</div>
                  <div className="c-step">
                    {c.stepName} · {c.lifecycle}
                  </div>
                  {c.note && <div className="c-note">{c.note}</div>}
                  <div className="c-agent">
                    {c.agentId} · {elapsed(c.claimedAt)} ago
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="live-section">
          <h2>Waiting on you</h2>
          {notifications.length === 0 ? (
            <p className="empty-hint">Nothing waiting.</p>
          ) : (
            <ul className="live-notif-list notification-list">
              {notifications.map((n) => (
                <li key={n.id}>
                  <div>
                    <p className="n-message">{n.message}</p>
                    <p className="n-meta">
                      {n.sessionId}
                      {n.cwd && ` · ${n.cwd}`}
                    </p>
                  </div>
                  <button onClick={() => ack(n.id)}>Acknowledge</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Config rules ──────────────────────────────────────────────────────────────

function RulesPanel() {
  const [rules, setRules] = useState<ConfigRule[] | null>(null);
  const [pattern, setPattern] = useState("");
  const [context, setContext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPattern, setEditPattern] = useState("");
  const [editContext, setEditContext] = useState("");

  const reload = async () => {
    const res = await window.api.listConfigRules();
    setRules(res.ok ? res.result : null);
    if (!res.ok) setError(res.error);
  };

  useEffect(() => {
    reload();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await window.api.createConfigRule(pattern, context);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPattern("");
    setContext("");
    reload();
  };

  const remove = async (id: number) => {
    const res = await window.api.deleteConfigRule(id);
    if (!res.ok) setError(res.error);
    reload();
  };

  const startEdit = (rule: ConfigRule) => {
    setEditingId(rule.id);
    setEditPattern(rule.pattern);
    setEditContext(rule.context);
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingId === null) return;
    setError(null);
    const res = await window.api.updateConfigRule(editingId, {
      pattern: editPattern,
      context: editContext,
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditingId(null);
    reload();
  };

  return (
    <div className="panel">
      <form className="rule-form" onSubmit={submit}>
        <input
          placeholder="pattern (e.g. * or **/app-shedul*)"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
        />
        <textarea
          placeholder="context to inject"
          value={context}
          onChange={(e) => setContext(e.target.value)}
        />
        <button type="submit">Add rule</button>
      </form>
      {error && <p className="status status-down">{error}</p>}
      {rules === null && <p className="status status-pending">Loading…</p>}
      {rules?.length === 0 && <p className="status status-pending">No rules yet.</p>}
      <ul className="rule-list">
        {rules?.map((rule) =>
          editingId === rule.id ? (
            <li key={rule.id} className="rule-item">
              <form className="rule-edit-form" onSubmit={saveEdit}>
                <div className="rule-item-row">
                  <input
                    className="rule-edit-pattern"
                    value={editPattern}
                    onChange={(e) => setEditPattern(e.target.value)}
                  />
                  <div className="rule-item-actions">
                    <button type="submit">Save</button>
                    <button type="button" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                </div>
                <textarea
                  className="rule-item-context rule-edit-context"
                  value={editContext}
                  onChange={(e) => setEditContext(e.target.value)}
                />
              </form>
            </li>
          ) : (
            <li key={rule.id} className="rule-item">
              <div className="rule-item-row">
                <code>{rule.pattern}</code>
                <div className="rule-item-actions">
                  <button onClick={() => startEdit(rule)}>Edit</button>
                  <button onClick={() => remove(rule.id)}>Delete</button>
                </div>
              </div>
              <span className="rule-item-context">{rule.context}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function AgentsPanel() {
  const [adapters, setAdapters] = useState<AgentAdapter[] | null>(null);
  const [name, setName] = useState("");
  const [binary, setBinary] = useState("");
  const [yoloFlag, setYoloFlag] = useState("");
  const [mcpConfigFlag, setMcpConfigFlag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editBinary, setEditBinary] = useState("");
  const [editYoloFlag, setEditYoloFlag] = useState("");
  const [editMcpConfigFlag, setEditMcpConfigFlag] = useState("");

  const reload = async () => {
    const res = await window.api.listAgentAdapters();
    setAdapters(res.ok ? res.result : null);
    if (!res.ok) setError(res.error);
  };

  useEffect(() => {
    reload();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await window.api.createAgentAdapter(name, binary, yoloFlag || undefined, mcpConfigFlag || undefined);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setName("");
    setBinary("");
    setYoloFlag("");
    setMcpConfigFlag("");
    reload();
  };

  const remove = async (id: number) => {
    const res = await window.api.deleteAgentAdapter(id);
    if (!res.ok) setError(res.error);
    reload();
  };

  const startEdit = (adapter: AgentAdapter) => {
    setEditingId(adapter.id);
    setEditName(adapter.name);
    setEditBinary(adapter.binary);
    setEditYoloFlag(adapter.yoloFlag ?? "");
    setEditMcpConfigFlag(adapter.mcpConfigFlag ?? "");
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingId === null) return;
    setError(null);
    const res = await window.api.updateAgentAdapter(editingId, {
      name: editName,
      binary: editBinary,
      yoloFlag: editYoloFlag,
      mcpConfigFlag: editMcpConfigFlag,
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditingId(null);
    reload();
  };

  return (
    <div className="panel">
      <form className="rule-form" onSubmit={submit}>
        <input placeholder="name (e.g. Claude)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="binary (e.g. claude)" value={binary} onChange={(e) => setBinary(e.target.value)} />
        <input
          placeholder="yolo flag (optional, e.g. --dangerously-skip-permissions)"
          value={yoloFlag}
          onChange={(e) => setYoloFlag(e.target.value)}
        />
        <input
          placeholder="mcp config flag (optional, e.g. --mcp-config {path})"
          value={mcpConfigFlag}
          onChange={(e) => setMcpConfigFlag(e.target.value)}
        />
        <button type="submit">Add agent</button>
      </form>
      {error && <p className="status status-down">{error}</p>}
      {adapters === null && <p className="status status-pending">Loading…</p>}
      {adapters?.length === 0 && <p className="status status-pending">No agents yet.</p>}
      <ul className="rule-list">
        {adapters?.map((adapter) =>
          editingId === adapter.id ? (
            <li key={adapter.id} className="rule-item">
              <form className="rule-edit-form" onSubmit={saveEdit}>
                <div className="rule-item-row">
                  <input
                    className="rule-edit-pattern"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                  <div className="rule-item-actions">
                    <button type="submit">Save</button>
                    <button type="button" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                </div>
                <input
                  className="rule-edit-pattern"
                  placeholder="binary"
                  value={editBinary}
                  onChange={(e) => setEditBinary(e.target.value)}
                />
                <input
                  className="rule-edit-pattern"
                  placeholder="yolo flag (optional)"
                  value={editYoloFlag}
                  onChange={(e) => setEditYoloFlag(e.target.value)}
                />
                <input
                  className="rule-edit-pattern"
                  placeholder="mcp config flag (optional)"
                  value={editMcpConfigFlag}
                  onChange={(e) => setEditMcpConfigFlag(e.target.value)}
                />
              </form>
            </li>
          ) : (
            <li key={adapter.id} className="rule-item">
              <div className="rule-item-row">
                <code>{adapter.name}</code>
                <div className="rule-item-actions">
                  <button onClick={() => startEdit(adapter)}>Edit</button>
                  <button onClick={() => remove(adapter.id)}>Delete</button>
                </div>
              </div>
              <span className="rule-item-context">
                {adapter.binary}
                {adapter.yoloFlag ? ` · ${adapter.yoloFlag}` : ""}
                {adapter.mcpConfigFlag ? ` · ${adapter.mcpConfigFlag}` : ""}
              </span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

// ── Inbox ─────────────────────────────────────────────────────────────────────

function InboxPanel() {
  const [unacknowledgedOnly, setUnacknowledgedOnly] = useState(true);
  const [notifications, setNotifications] = useState<Notification[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const res = await window.api.listNotifications(unacknowledgedOnly);
      if (!cancelled && res.ok) setNotifications(res.result);
    };
    poll();
    const id = setInterval(poll, POLL_FAST);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [unacknowledgedOnly]);

  const ack = async (id: number) => {
    await window.api.acknowledgeNotification(id);
    const res = await window.api.listNotifications(unacknowledgedOnly);
    if (res.ok) setNotifications(res.result);
  };

  return (
    <div className="panel">
      <label className="toggle">
        <input
          type="checkbox"
          checked={unacknowledgedOnly}
          onChange={(e) => setUnacknowledgedOnly(e.target.checked)}
        />
        Unacknowledged only
      </label>
      {notifications === null && <p className="status status-pending">Loading…</p>}
      {notifications?.length === 0 && (
        <p className="status status-pending">Nothing waiting on you.</p>
      )}
      <ul className="notification-list">
        {notifications?.map((n) => (
          <li key={n.id} className={n.acknowledgedAt ? "acked" : ""}>
            <div>
              <p className="n-message">{n.message}</p>
              <p className="n-meta">
                {n.sessionId}
                {n.cwd && <> · {n.cwd}</>} · {n.createdAt}
              </p>
            </div>
            {!n.acknowledgedAt && <button onClick={() => ack(n.id)}>Acknowledge</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
