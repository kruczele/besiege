export interface Migration {
  name: string;
  sql: string;
}

// Applied in array order, once each, tracked in schema_migrations.
// Append new migrations here — never edit one that has already shipped.
export const migrations: Migration[] = [
  {
    name: "0001_daemon_startups",
    sql: `
      CREATE TABLE daemon_startups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL
      );
    `,
  },
  {
    name: "0002_config_rules",
    sql: `
      -- Glob pattern -> context text. Resolved by matching a session's cwd
      -- against every rule and concatenating hits in id (insertion) order —
      -- not "most specific wins". "*" is just the trivial always-match rule.
      CREATE TABLE config_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL,
        context TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    name: "0003_notifications",
    sql: `
      -- Posted by the Notification hook when a session is idle/waiting on
      -- input, so the operator sees it in one place instead of checking
      -- every terminal. acknowledged_at is null until dismissed.
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        cwd TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
    `,
  },
];
