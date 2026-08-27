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
  {
    name: "0004_campaigns",
    sql: `
      CREATE TABLE campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    name: "0005_campaign_steps",
    sql: `
      CREATE TABLE campaign_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
        name TEXT NOT NULL,
        step_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(campaign_id, step_order)
      );
    `,
  },
  {
    name: "0006_campaign_repos",
    sql: `
      CREATE TABLE campaign_repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
        github_full_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(campaign_id, github_full_name)
      );
    `,
  },
  {
    name: "0007_task_definitions",
    sql: `
      -- Instructions for a step. 'since' enables retroactive assignment: any PR
      -- in this step that predates 'since' gets this task added as pending.
      CREATE TABLE task_definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step_id INTEGER NOT NULL REFERENCES campaign_steps(id),
        name TEXT NOT NULL,
        context TEXT NOT NULL,
        since TEXT NOT NULL,
        retired_at TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    name: "0008_prs",
    sql: `
      -- One PR per (step, repo). github_pr_number and github_node_id are null
      -- until an agent opens the PR and reports back.
      -- ci_failure_signature_id reserved for §5 memory service (not yet built).
      CREATE TABLE prs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step_id INTEGER NOT NULL REFERENCES campaign_steps(id),
        repo_id INTEGER NOT NULL REFERENCES campaign_repos(id),
        github_pr_number INTEGER,
        github_node_id TEXT,
        lifecycle TEXT NOT NULL DEFAULT 'not-started',
        ci_status TEXT NOT NULL DEFAULT 'unknown',
        ci_check_name TEXT,
        review_approved INTEGER NOT NULL DEFAULT 0,
        unaddressed_feedback INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(step_id, repo_id)
      );
    `,
  },
  {
    name: "0009_pr_pending_tasks",
    sql: `
      -- Tasks assigned to a PR but not yet applied. closed_at null = still pending.
      CREATE TABLE pr_pending_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id INTEGER NOT NULL REFERENCES prs(id),
        task_definition_id INTEGER NOT NULL REFERENCES task_definitions(id),
        closed_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(pr_id, task_definition_id)
      );
    `,
  },
  {
    name: "0010_pr_claims",
    sql: `
      -- Advisory lease on a PR. Agents heartbeat while working; daemon expires
      -- stale claims automatically. released_at null = active.
      CREATE TABLE pr_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id INTEGER NOT NULL REFERENCES prs(id),
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        note TEXT,
        claimed_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE INDEX pr_claims_active_idx ON pr_claims(pr_id) WHERE released_at IS NULL;
    `,
  },
  {
    name: "0011_failure_signatures",
    sql: `
      -- Organically accumulated failure patterns. Keyed on campaign × signature so
      -- the same lint rule appearing in different steps resolves to the same fix.
      -- hit_count increments on each upsert so the operator can see recurrence rate.
      CREATE TABLE failure_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
        signature TEXT NOT NULL,
        fix_context TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(campaign_id, signature)
      );
    `,
  },
  {
    name: "0012_prs_failure_sig_index",
    sql: `
      -- Column was reserved (see 0008 comment) but never actually added until now.
      ALTER TABLE prs ADD COLUMN ci_failure_signature_id INTEGER REFERENCES failure_signatures(id);

      -- Index for efficient lookup of PRs by failure signature (used by sync engine).
      CREATE INDEX IF NOT EXISTS prs_failure_sig_idx
        ON prs(ci_failure_signature_id)
        WHERE ci_failure_signature_id IS NOT NULL;
    `,
  },
];
