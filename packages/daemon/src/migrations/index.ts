import type Database from "better-sqlite3";
import { chainFromSessionIds } from "../layout-tree.js";

export interface Migration {
  name: string;
  sql: string;
  // Runs once, in the same transaction as `sql`, right after it — for
  // backfills that need JS logic (e.g. JSON tree construction) rather than
  // being expressible as a plain SQL statement.
  after?: (db: Database.Database) => void;
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
  {
    name: "0013_campaign_default_dir",
    sql: `
      -- Directory a new terminal session for this campaign starts in by default.
      ALTER TABLE campaigns ADD COLUMN default_dir TEXT;
    `,
  },
  {
    name: "0014_terminal_sessions",
    sql: `
      -- One row per PTY the daemon has ever spawned. 'status' tracks whether the
      -- process is alive *in this daemon process* — a restart can never resume a
      -- live PTY, so boot logic marks all 'active' rows 'exited' (exit_code NULL,
      -- meaning "lost to a daemon restart" rather than a real exit) before the
      -- HTTP server starts listening. Scrollback itself is NOT persisted here —
      -- it lives in an in-memory ring buffer per session and is lost on restart
      -- same as the live process is.
      CREATE TABLE terminal_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
        label TEXT,
        cwd TEXT NOT NULL,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        exit_code INTEGER,
        created_at TEXT NOT NULL,
        exited_at TEXT
      );
    `,
  },
  {
    name: "0015_agent_adapters",
    sql: `
      -- User-editable launch definitions for interactive coding-agent CLIs
      -- (claude/opencode/agy/...). Deliberately a plain data table rather than
      -- hardcoded adapter logic in daemon source: flags for third-party CLIs
      -- are easy to get wrong or for the CLI to change, and the user can fix
      -- a row here without a code change. Seed rows below are a best-effort
      -- starting point, not guaranteed-correct forever.
      CREATE TABLE agent_adapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        binary TEXT NOT NULL,
        yolo_flag TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO agent_adapters (name, binary, yolo_flag, created_at) VALUES
        ('Claude', 'claude', '--dangerously-skip-permissions', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('OpenCode', 'opencode', '--auto', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('Antigravity (agy)', 'agy', '--dangerously-skip-permissions', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
  {
    name: "0016_terminal_sessions_agent",
    sql: `
      -- Which agent adapter (if any) a terminal session was launched with, and
      -- the launch options chosen at creation time. NULL agent_adapter_id means
      -- a plain shell, the pre-existing default behavior.
      ALTER TABLE terminal_sessions ADD COLUMN agent_adapter_id INTEGER REFERENCES agent_adapters(id);
      ALTER TABLE terminal_sessions ADD COLUMN yolo INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE terminal_sessions ADD COLUMN extra_args TEXT;
    `,
  },
  {
    name: "0017_agent_adapter_mcp_config",
    sql: `
      -- Flag template (e.g. "--mcp-config {path}") for wiring the besiege MCP
      -- server into a spawned agent session. {path} is substituted with the
      -- absolute path to the daemon-generated mcp-config.json at spawn time.
      -- NULL means this adapter's CLI has no known MCP-config flag.
      ALTER TABLE agent_adapters ADD COLUMN mcp_config_flag TEXT;
      UPDATE agent_adapters SET mcp_config_flag = '--mcp-config {path}' WHERE binary = 'claude';
    `,
  },
  {
    name: "0018_terminal_layouts",
    sql: `
      -- A "meta-tab": a named, saved grid of terminal sessions shown together
      -- as one visual context (e.g. 4 agents side by side), as an alternative
      -- to viewing sessions one at a time via the plain session tabs.
      CREATE TABLE terminal_layouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Ordered membership: which sessions appear in a layout's grid, and in
      -- what order. position is dense (0..n-1) per layout.
      CREATE TABLE terminal_layout_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        layout_id INTEGER NOT NULL REFERENCES terminal_layouts(id) ON DELETE CASCADE,
        terminal_session_id INTEGER NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        UNIQUE (layout_id, terminal_session_id)
      );
    `,
  },
  {
    name: "0019_terminal_layout_tree",
    sql: `
      -- The grid is now an arbitrary tmux-style split tree (see PaneNode in
      -- layout-tree.ts) instead of a flat, fixed-size square grid, so a
      -- layout's content is a single JSON column rather than a join table.
      -- terminal_layout_members is left in place (harmless, unused) rather
      -- than dropped, matching this file's additive-only convention.
      -- is_name_custom tracks whether 'name' was set by the user (sticks) or
      -- should keep being recomputed from the first pane's live terminal
      -- title.
      ALTER TABLE terminal_layouts ADD COLUMN layout_tree TEXT NOT NULL DEFAULT '';
      ALTER TABLE terminal_layouts ADD COLUMN is_name_custom INTEGER NOT NULL DEFAULT 0;
    `,
    after: (db) => {
      const layouts = db.prepare("SELECT id FROM terminal_layouts").all() as { id: number }[];
      const memberStmt = db.prepare(
        "SELECT terminal_session_id FROM terminal_layout_members WHERE layout_id = ? ORDER BY position ASC",
      );
      const update = db.prepare("UPDATE terminal_layouts SET layout_tree = ? WHERE id = ?");
      for (const { id } of layouts) {
        const memberIds = (memberStmt.all(id) as { terminal_session_id: number }[]).map(
          (r) => r.terminal_session_id,
        );
        update.run(JSON.stringify(chainFromSessionIds(memberIds)), id);
      }
    },
  },
  {
    name: "0020_agent_adapter_resume_flags",
    sql: `
      -- Flag templates (e.g. "--session-id {sessionId}" / "--resume {sessionId}")
      -- for pinning and later resuming an agent CLI's own conversation, same
      -- {placeholder} substitution pattern as mcp_config_flag's {path}. NULL
      -- means this adapter's CLI has no known resume support — a daemon
      -- restart just loses that session like it always has.
      ALTER TABLE agent_adapters ADD COLUMN session_id_flag TEXT;
      ALTER TABLE agent_adapters ADD COLUMN resume_flag TEXT;
      UPDATE agent_adapters SET session_id_flag = '--session-id {sessionId}', resume_flag = '--resume {sessionId}'
        WHERE binary = 'claude';
    `,
  },
  {
    name: "0021_terminal_session_agent_session_id",
    sql: `
      -- The agent CLI's own conversation/session id (distinct from this row's
      -- own id, which changes across a resume since it's a new PID) — set at
      -- spawn time when the adapter has a session_id_flag, carried forward
      -- across a boot-time resume so the same id can be reused again next time.
      ALTER TABLE terminal_sessions ADD COLUMN agent_session_id TEXT;
    `,
  },
];
