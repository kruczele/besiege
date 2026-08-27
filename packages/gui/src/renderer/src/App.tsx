import { useEffect, useState } from "react";
import type {
  ActiveClaim,
  Campaign,
  CampaignStep,
  ConfigRule,
  DaemonHealth,
  DaemonResult,
  Notification,
  PrGridRow,
} from "../../shared/types.js";

const POLL_FAST = 3000;
const POLL_GRID = 5000;

type Tab = "status" | "campaigns" | "live" | "rules" | "inbox";

export function App() {
  const [tab, setTab] = useState<Tab>("campaigns");

  return (
    <main className="shell">
      <h1>Besiege</h1>
      <nav className="tabs">
        {(["status", "campaigns", "live", "rules", "inbox"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === "status" && <StatusPanel />}
      {tab === "campaigns" && <CampaignsPanel />}
      {tab === "live" && <LivePanel />}
      {tab === "rules" && <RulesPanel />}
      {tab === "inbox" && <InboxPanel />}
    </main>
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
    <div className="status status-up">
      <p>
        Daemon connected — pid {result.result.pid}, up {result.result.uptimeSeconds}s
      </p>
      <p>
        Startups recorded: {result.result.db.startupCount}
        {result.result.db.lastStartedAt && <> (last {result.result.db.lastStartedAt})</>}
      </p>
    </div>
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

function CampaignsPanel() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [steps, setSteps] = useState<CampaignStep[]>([]);
  const [prs, setPrs] = useState<PrGridRow[]>([]);
  const [needsMe, setNeedsMe] = useState(true);
  const [syncing, setSyncing] = useState(false);

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
    return <p className="status status-pending">No campaigns yet. Create one via the daemon API.</p>;
  }

  return (
    <div className="panel">
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
      </div>

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
        {rules?.map((rule) => (
          <li key={rule.id}>
            <code>{rule.pattern}</code>
            <span>{rule.context}</span>
            <button onClick={() => remove(rule.id)}>Delete</button>
          </li>
        ))}
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
