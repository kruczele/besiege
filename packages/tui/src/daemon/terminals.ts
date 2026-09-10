import { callDaemon } from "./client.js";
import type { TerminalSession } from "./types.js";

export const listTerminals = (campaignId: number) =>
  callDaemon<TerminalSession[]>("GET", `/campaigns/${campaignId}/terminals`);
export const createTerminal = (
  campaignId: number,
  cwd?: string,
  label?: string,
  agentAdapterName?: string,
  yolo?: boolean,
  extraArgs?: string,
  resumeFromTerminalId?: number,
) =>
  callDaemon<TerminalSession>("POST", `/campaigns/${campaignId}/terminals`, {
    cwd,
    label,
    agentAdapterName,
    yolo,
    extraArgs,
    resumeFromTerminalId,
  });
export const getTerminal = (id: number) => callDaemon<TerminalSession>("GET", `/terminals/${id}`);
export const getTerminalByAgentSession = (agentSessionId: string) =>
  callDaemon<TerminalSession>(
    "GET",
    `/terminal-sessions/by-agent-session/${encodeURIComponent(agentSessionId)}`,
  );
export const killTerminal = (id: number) => callDaemon<{ ok: boolean }>("POST", `/terminals/${id}/kill`);
export const deleteTerminal = (id: number) => callDaemon<void>("DELETE", `/terminals/${id}`);
