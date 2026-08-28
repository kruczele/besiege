// Types shared between the main process and the renderer (via preload).
// Kept type-only and dependency-free so both tsconfig.node.json and
// tsconfig.web.json can include this file without crossing their
// Node/DOM project boundary.

export interface DaemonHealth {
  status: string;
  pid: number;
  uptimeSeconds: number;
  db: { startupCount: number; lastStartedAt?: string };
}

export interface ConfigRule {
  id: number;
  pattern: string;
  context: string;
  createdAt: string;
}

export interface Notification {
  id: number;
  sessionId: string;
  cwd: string | null;
  message: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

export type DaemonResult<T> = { ok: true; result: T } | { ok: false; error: string };

export interface Campaign {
  id: number;
  name: string;
  description: string | null;
  defaultDir: string | null;
  createdAt: string;
}

export type TerminalStatus = "active" | "exited";

export interface TerminalSession {
  id: number;
  campaignId: number;
  label: string | null;
  cwd: string;
  pid: number | null;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: string;
  exitedAt: string | null;
  agentAdapterName: string | null;
  yolo: boolean;
  extraArgs: string | null;
  agentSessionId: string | null;
}

// A hand-edited YAML config (agents.default.yaml + agents.local.yaml), not a
// database table — read-only from the GUI's perspective, no id/createdAt.
export interface AgentAdapter {
  name: string;
  binary: string;
  yoloFlag: string | null;
  mcpConfigFlag: string | null;
  sessionIdFlag: string | null;
  resumeFlag: string | null;
}

// A pane grid is an arbitrary tmux-style binary split tree rather than a
// flat, fixed-size square grid: a leaf is one pane (empty, or holding a
// terminal session); a split is a row/col division of two child nodes at a
// given ratio. Mirrored (duplicated, not shared — different runtimes) in
// packages/daemon/src/layout-tree.ts, which owns the authoritative pure
// tree-manipulation functions server-side.
export interface PaneLeaf {
  type: "leaf";
  id: string;
  sessionId: number | null;
}

export interface PaneSplit {
  type: "split";
  id: string;
  dir: "row" | "col";
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface TerminalLayout {
  id: number;
  campaignId: number;
  name: string;
  createdAt: string;
  isNameCustom: boolean;
  tree: PaneNode;
}

export interface CampaignStep {
  id: number;
  campaignId: number;
  name: string;
  stepOrder: number;
  createdAt: string;
}

export interface CampaignRepo {
  id: number;
  campaignId: number;
  githubFullName: string;
  createdAt: string;
}

export interface TaskDefinition {
  id: number;
  stepId: number;
  name: string;
  context: string;
  since: string;
  retiredAt: string | null;
  createdAt: string;
}

export type PrLifecycle = "not-started" | "open" | "approved" | "changes-requested" | "merged" | "closed";
export type CiStatus = "unknown" | "passing" | "failing";

export interface Pr {
  id: number;
  stepId: number;
  repoId: number;
  githubPrNumber: number | null;
  githubNodeId: string | null;
  lifecycle: PrLifecycle;
  ciStatus: CiStatus;
  ciCheckName: string | null;
  reviewApproved: boolean;
  unaddressedFeedback: boolean;
  syncedAt: string | null;
  createdAt: string;
}

export interface PrGridRow extends Pr {
  repoName: string;
  stepName: string;
  stepOrder: number;
  pendingTasksCount: number;
}

export interface PrPendingTask {
  id: number;
  prId: number;
  taskDefinitionId: number;
  taskName: string;
  taskContext: string;
  closedAt: string | null;
  createdAt: string;
}

export interface PrClaim {
  id: number;
  prId: number;
  agentId: string;
  sessionId: string;
  note: string | null;
  claimedAt: string;
  heartbeatAt: string;
  releasedAt: string | null;
}

export interface ActiveClaim extends PrClaim {
  githubPrNumber: number | null;
  lifecycle: string;
  stepName: string;
  repoName: string;
}

export interface FailureSignature {
  id: number;
  campaignId: number;
  signature: string;
  fixContext: string;
  hitCount: number;
  createdAt: string;
  updatedAt: string;
}
