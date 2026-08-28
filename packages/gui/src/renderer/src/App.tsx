import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import type {
  ActiveClaim,
  Campaign,
  CampaignStep,
  ConfigRule,
  DaemonHealth,
  DaemonResult,
  Notification,
  PrGridRow,
  TaskDefinition,
  TerminalSession,
} from "../../shared/types.js";
import { TerminalsMain } from "./Terminals.js";

const POLL_FAST = 3000;
const POLL_GRID = 5000;

type Tab = "campaigns" | "live" | "rules";

// Display labels only — internal tab/component names are unchanged so this
// is a pure cosmetic rename, not a functional split.
const TAB_LABEL: Record<Tab, string> = { campaigns: "Campaigns", live: "Army", rules: "Edicts" };
const TAB_HELPTEXT: Record<Tab, string> = {
  campaigns: "Coordinate multi-repo initiatives and track their progress from start to finish.",
  live: "See your agents, what they're working on, and where they need you.",
  rules: "Define standing rules and context that guide your agents.",
};

export function App() {
  const [tab, setTab] = useState<Tab>("campaigns");
  // The campaign currently in focus — set by CampaignsPanel's selector, read
  // by the main terminal area so "new terminal" knows which campaign it
  // belongs to. Terminals are children of campaigns, so there's one shared
  // notion of "current campaign" across the sidebar and the terminal area.
  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(null);
  // Set by "Jump to agent" (Inbox, Army tab) — see TerminalsMain's
  // focusRequest prop for how the terminal area resolves this into an
  // actual tab/pane selection once that campaign's grid has loaded.
  const [focusRequest, setFocusRequest] = useState<{ campaignId: number; terminalId: number } | null>(null);
  const jumpToSession = (campaignId: number, terminalId: number) => {
    setActiveCampaignId(campaignId);
    setFocusRequest({ campaignId, terminalId });
  };
  // Lifted up from TerminalsMain so the Army tab can show a session's live
  // title too, not just whichever pane happens to be mounted.
  const [titles, setTitles] = useState<Record<number, string>>({});
  const onTitleChange = (id: number, title: string) => setTitles((prev) => ({ ...prev, [id]: title }));

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
            {(["campaigns", "live", "rules"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </nav>
          <p className="tab-helptext">{TAB_HELPTEXT[tab]}</p>
          <div className="sidebar-content">
            {tab === "campaigns" && (
              <CampaignsPanel activeCampaignId={activeCampaignId} onSelectCampaign={setActiveCampaignId} />
            )}
            {tab === "live" && <LivePanel onJump={jumpToSession} titles={titles} />}
            {tab === "rules" && <RulesPanel />}
          </div>
          <InboxPanel onJump={jumpToSession} titles={titles} />
          <div className="sidebar-footer">
            <StatusPanel />
          </div>
        </aside>
        <main className="main">
          <TerminalsMain
            campaignId={activeCampaignId}
            focusRequest={focusRequest}
            onFocusHandled={() => setFocusRequest(null)}
            titles={titles}
            onTitleChange={onTitleChange}
          />
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
          <Minus size={14} />
        </button>
        <button
          className="title-bar-btn"
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={() => window.api.toggleMaximizeWindow()}
        >
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>
        <button
          className="title-bar-btn title-bar-btn-close"
          aria-label="Close"
          onClick={() => window.api.closeWindow()}
        >
          <X size={14} />
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

// Button-row campaign switcher shared by CampaignsPanel and LivePanel —
// there are only ever a handful of campaigns, so a pill row reads faster
// than a dropdown and matches the rest of the "buttons over dropdowns" pass.
function CampaignPicker({
  campaigns,
  selectedId,
  onSelect,
}: {
  campaigns: Campaign[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="campaign-picker">
      {campaigns.map((c) => (
        <button
          key={c.id}
          className={`campaign-picker-btn ${selectedId === c.id ? "selected" : ""}`}
          onClick={() => onSelect(c.id)}
        >
          {c.name}
        </button>
      ))}
    </div>
  );
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
        <CampaignPicker campaigns={campaigns} selectedId={selectedId} onSelect={onSelectCampaign} />
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

      {selectedId !== null && <TasksPanel campaignId={selectedId} steps={steps} />}
    </div>
  );
}

// Human-authored task definitions per step — instructions applied to every PR
// in that step (agents can also self-serve this via the create_task MCP
// tool; this is the same underlying route, just from the GUI side).
function TasksPanel({ campaignId, steps }: { campaignId: number; steps: CampaignStep[] }) {
  const [selectedStepId, setSelectedStepId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [since, setSince] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedStepId((cur) => (cur !== null && steps.some((s) => s.id === cur) ? cur : (steps[0]?.id ?? null)));
  }, [steps]);

  const reload = async (stepId: number) => {
    const res = await window.api.listTasks(campaignId, stepId);
    if (res.ok) setTasks(res.result);
  };

  useEffect(() => {
    if (selectedStepId !== null) reload(selectedStepId);
    else setTasks([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, selectedStepId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedStepId === null) return;
    setError(null);
    const res = await window.api.createTask(campaignId, selectedStepId, name, context, new Date(since).toISOString());
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setName("");
    setContext("");
    reload(selectedStepId);
  };

  const retire = async (taskId: number) => {
    if (selectedStepId === null) return;
    await window.api.retireTask(campaignId, selectedStepId, taskId);
    reload(selectedStepId);
  };

  if (steps.length === 0) return null;

  return (
    <div className="tasks-panel">
      <h2>Tasks</h2>
      <div className="campaign-picker">
        {steps.map((s) => (
          <button
            key={s.id}
            className={`campaign-picker-btn ${selectedStepId === s.id ? "selected" : ""}`}
            onClick={() => setSelectedStepId(s.id)}
          >
            {s.name}
          </button>
        ))}
      </div>

      {error && <p className="status status-down">{error}</p>}

      <ul className="rule-list">
        {tasks.length === 0 && <span className="empty-hint">No tasks for this step yet.</span>}
        {tasks.map((t) => (
          <li key={t.id} className="rule-item">
            <div className="rule-item-row">
              <code>{t.name}</code>
              <div className="rule-item-actions">
                <button onClick={() => retire(t.id)}>Retire</button>
              </div>
            </div>
            <span className="rule-item-context">{t.context}</span>
          </li>
        ))}
      </ul>

      <form className="rule-form" onSubmit={submit}>
        <input placeholder="task name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          placeholder="instructions to apply to every PR in this step"
          value={context}
          onChange={(e) => setContext(e.target.value)}
        />
        <input
          type="date"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          title="Existing PRs in this step created before this date get the task added retroactively"
        />
        <button type="submit" disabled={!name.trim() || !context.trim()}>
          Add task
        </button>
      </form>
    </div>
  );
}

// ── Notifications (shared by the always-visible Inbox and the Live board) ──────

// A notification only carries the raw BESIEGE_SESSION_ID string of whoever
// raised it — this resolves that to the terminal session that owns it (if
// any), so the UI can show something meaningful instead of a bare id, and
// offer a way to jump straight to it. Cached across notifications, since the
// same session commonly raises more than one.
function useSessionLookup(sessionIds: string[]): Record<string, TerminalSession | null> {
  const [cache, setCache] = useState<Record<string, TerminalSession | null>>({});

  useEffect(() => {
    const missing = sessionIds.filter((id) => !(id in cache));
    for (const id of missing) {
      window.api.getTerminalByAgentSession(id).then((res) => {
        setCache((prev) => (id in prev ? prev : { ...prev, [id]: res.ok ? res.result : null }));
      });
    }
    // Re-run only when the *set* of ids changes, not when `cache` fills in —
    // otherwise every resolved id would immediately re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIds.join(",")]);

  return cache;
}

// Message and meta/actions are deliberately separate rows — cramming a
// multi-line message next to a button in one flex row is what made this
// unreadable before. The whole tile is clickable (not just a small link)
// when it resolves to a session, per feedback that a tiny button was easy
// to miss.
function NotificationCard({
  notification,
  session,
  titles,
  onAck,
  onJump,
}: {
  notification: Notification;
  session: TerminalSession | null | undefined;
  titles: Record<number, string>;
  onAck: (id: number) => void;
  onJump: (campaignId: number, terminalId: number) => void;
}) {
  const title = session ? (titles[session.id] ?? session.label ?? session.agentAdapterName ?? `Terminal #${session.id}`) : null;

  return (
    <li
      className={`notification-card ${notification.acknowledgedAt ? "acked" : ""} ${session ? "clickable" : ""}`}
      onClick={session ? () => onJump(session.campaignId, session.id) : undefined}
    >
      <p className="n-message">{notification.message}</p>
      <div className="n-meta-row">
        <span className="n-meta">
          {title ?? notification.cwd ?? "unknown session"} · {elapsed(notification.createdAt)} ago
        </span>
        <div className="n-actions">
          {!notification.acknowledgedAt && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAck(notification.id);
              }}
            >
              Acknowledge
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

// ── Live board ────────────────────────────────────────────────────────────────

// The "Army" tab — active agents only. Notifications used to be duplicated
// here as "Waiting on you", but the always-visible Inbox covers that
// completely now, so this is just the one list.
function LivePanel({
  onJump,
  titles,
}: {
  onJump: (campaignId: number, terminalId: number) => void;
  titles: Record<number, string>;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [claims, setClaims] = useState<ActiveClaim[]>([]);
  const [runningAgents, setRunningAgents] = useState<TerminalSession[]>([]);

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
      const [claimsRes, terminalsRes] = await Promise.all([
        window.api.listCampaignClaims(selectedId),
        window.api.listTerminals(selectedId),
      ]);
      if (cancelled) return;
      if (claimsRes.ok) setClaims(claimsRes.result);
      // Shows up here purely from being spawned with an agent adapter — no
      // claim required, so a pane-launched agent is visible immediately
      // instead of only after (if ever) it calls the claim_pr MCP tool.
      if (terminalsRes.ok) {
        setRunningAgents(terminalsRes.result.filter((s) => s.status === "active" && s.agentAdapterName !== null));
      }
    };

    poll();
    const id = setInterval(poll, POLL_FAST);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedId]);

  // A claim only carries the raw session_id string it was made with — this
  // is what makes a claim tile clickable/jumpable, same mechanism as Inbox.
  const sessionsForClaims = useSessionLookup(claims.map((c) => c.sessionId));

  const release = async (prId: number) => {
    await window.api.releaseClaim(prId);
    if (selectedId !== null) {
      const res = await window.api.listCampaignClaims(selectedId);
      if (res.ok) setClaims(res.result);
    }
  };

  return (
    <div className="panel">
      {campaigns.length > 1 && (
        <div className="campaign-toolbar">
          <CampaignPicker campaigns={campaigns} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      )}
      {claims.length === 0 && runningAgents.length === 0 ? (
        <p className="empty-hint">No agents running.</p>
      ) : (
        <ul className="claim-list">
          {claims.map((c) => {
            const session = sessionsForClaims[c.sessionId];
            return (
              <li
                key={`claim-${c.id}`}
                className={`claim-card ${session ? "clickable" : ""}`}
                onClick={session ? () => onJump(session.campaignId, session.id) : undefined}
              >
                <div className="c-repo">{c.repoName}</div>
                <div className="c-step">
                  {c.stepName} · {c.lifecycle}
                </div>
                {c.note && <div className="c-note">{c.note}</div>}
                <div className="c-agent-row">
                  <div className="c-agent">
                    {c.agentId} · {elapsed(c.claimedAt)} ago
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      release(c.prId);
                    }}
                  >
                    Release
                  </button>
                </div>
              </li>
            );
          })}
          {/* Running from a pane launch, not (yet, or ever) claiming a
              specific PR — shown purely because the process is alive, no
              cooperation from the agent required. May overlap with a claim
              above once/if it does self-claim; not worth correlating the
              two just to de-duplicate. */}
          {runningAgents.map((s) => (
            <li key={`session-${s.id}`} className="claim-card clickable" onClick={() => onJump(s.campaignId, s.id)}>
              <div className="c-repo">{titles[s.id] ?? s.label ?? s.agentAdapterName}</div>
              <div className="c-step">{s.cwd}</div>
              <div className="c-agent">running · {elapsed(s.createdAt)}</div>
            </li>
          ))}
        </ul>
      )}
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

// ── Inbox ─────────────────────────────────────────────────────────────────────

// Always visible below whichever sidebar tab is active — not a tab itself,
// so it can't be navigated away from and forgotten about.
function InboxPanel({
  onJump,
  titles,
}: {
  onJump: (campaignId: number, terminalId: number) => void;
  titles: Record<number, string>;
}) {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const res = await window.api.listNotifications(true);
      if (!cancelled && res.ok) setNotifications(res.result);
    };
    poll();
    const id = setInterval(poll, POLL_FAST);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const sessions = useSessionLookup(notifications.map((n) => n.sessionId));

  const ack = async (id: number) => {
    await window.api.acknowledgeNotification(id);
    const res = await window.api.listNotifications(true);
    if (res.ok) setNotifications(res.result);
  };

  return (
    <div className="inbox-section">
      <h2>Inbox</h2>
      {notifications.length === 0 ? (
        <p className="empty-hint">Nothing waiting on you.</p>
      ) : (
        <ul className="notification-list">
          {notifications.map((n) => (
            <NotificationCard
              key={n.id}
              notification={n}
              session={sessions[n.sessionId]}
              titles={titles}
              onAck={ack}
              onJump={onJump}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
