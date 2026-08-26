import { useEffect, useState } from "react";
import type { DaemonHealthResult } from "../../preload/index";

const POLL_INTERVAL_MS = 3000;

export function App() {
  const [result, setResult] = useState<DaemonHealthResult | null>(null);

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

  return (
    <main className="shell">
      <h1>Besiege</h1>
      {result === null && <p className="status status-pending">Checking daemon…</p>}
      {result?.ok === false && (
        <p className="status status-down">Daemon unreachable — {result.error}</p>
      )}
      {result?.ok === true && (
        <div className="status status-up">
          <p>Daemon connected — pid {result.health.pid}, up {result.health.uptimeSeconds}s</p>
          <p>
            Startups recorded: {result.health.db.startupCount}
            {result.health.db.lastStartedAt && <> (last {result.health.db.lastStartedAt})</>}
          </p>
        </div>
      )}
    </main>
  );
}
