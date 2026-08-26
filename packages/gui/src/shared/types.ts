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
