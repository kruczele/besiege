// Wire-shape types for the daemon's JSON API. Duplicated from
// packages/gui/src/shared/types.ts (same precedent that file itself follows
// for packages/daemon/src/layout-tree.ts's *type* shapes) rather than shared,
// since the two packages' build graphs aren't wired together for arbitrary
// type-only imports. PaneNode itself is NOT duplicated here — the TUI is a
// plain Node process, so it imports the daemon's actual layout-tree module
// (types + functions) directly; see daemon/layout-tree.ts re-export below.

export type { PaneLeaf, PaneNode, PaneSplit } from "daemon/layout-tree.js";

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
  besiegeOnly: boolean;
  createdAt: string;
}

export interface Notification {
  id: number;
  sessionId: string;
  cwd: string | null;
  message: string;
  kind: "agent" | "hooks-missing";
  createdAt: string;
  acknowledgedAt: string | null;
  supersededAt: string | null;
}

export interface Campaign {
  id: number;
  name: string;
  description: string | null;
  defaultDir: string | null;
  createdAt: string;
  archivedAt: string | null;
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

export interface AgentAdapter {
  name: string;
  binary: string;
  yoloFlag: string | null;
  mcpConfigFlag: string | null;
  sessionIdFlag: string | null;
  resumeFlag: string | null;
}

export interface TerminalLayout {
  id: number;
  campaignId: number;
  name: string;
  createdAt: string;
  isNameCustom: boolean;
  tree: import("daemon/layout-tree.js").PaneNode;
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
  pinned: boolean;
  createdAt: string;
}

export interface TaskDefinition {
  id: number;
  stepId: number;
  name: string;
  context: string;
  retiredAt: string | null;
  createdAt: string;
}

export type PrLifecycle = "not-started" | "open" | "approved" | "changes-requested" | "merged" | "closed";
export type CiStatus = "unknown" | "running" | "passing" | "failing";
export type ReviewState = "missing" | "changes-requested" | "approved";

export interface Pr {
  id: number;
  // Null means the PR was registered with no step association.
  stepId: number | null;
  repoId: number;
  githubPrNumber: number | null;
  githubNodeId: string | null;
  lifecycle: PrLifecycle;
  ciStatus: CiStatus;
  ciCheckName: string | null;
  reviewState: ReviewState;
  branchName: string | null;
  syncedAt: string | null;
  createdAt: string;
}

export interface PrGridRow extends Pr {
  repoName: string;
  stepName: string | null;
  stepOrder: number | null;
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
