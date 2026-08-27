import { useEffect, useState } from "react";
import type { ConfigRule, DaemonHealth, DaemonResult, Notification } from "../../shared/types.js";

const POLL_INTERVAL_MS = 3000;

type Tab = "status" | "rules" | "inbox";

export function App() {
  const [tab, setTab] = useState<Tab>("status");

  return (
    <main className="shell">
      <h1>Besiege</h1>
      <nav className="tabs">
        <button className={tab === "status" ? "active" : ""} onClick={() => setTab("status")}>
          Status
        </button>
        <button className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}>
          Config Rules
        </button>
        <button className={tab === "inbox" ? "active" : ""} onClick={() => setTab("inbox")}>
          Inbox
        </button>
      </nav>
      {tab === "status" && <StatusPanel />}
      {tab === "rules" && <RulesPanel />}
      {tab === "inbox" && <InboxPanel />}
    </main>
  );
}

function StatusPanel() {
  const [result, setResult] = useState<DaemonResult<DaemonHealth> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const next = await window.api.getDaemonHealth();
      if (!cancelled) setResult(next);
    };
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
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
    const id = setInterval(poll, POLL_INTERVAL_MS);
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
      {notifications?.length === 0 && <p className="status status-pending">Nothing waiting on you.</p>}
      <ul className="notification-list">
        {notifications?.map((n) => (
          <li key={n.id} className={n.acknowledgedAt ? "acked" : ""}>
            <div>
              <p className="n-message">{n.message}</p>
              <p className="n-meta">
                {n.sessionId} {n.cwd && <>· {n.cwd}</>} · {n.createdAt}
              </p>
            </div>
            {!n.acknowledgedAt && <button onClick={() => ack(n.id)}>Acknowledge</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
