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
];
