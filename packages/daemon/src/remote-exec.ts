// The control plane's side of /exec/* (routes/exec.ts) on another host.
import { WebSocket } from "ws";
import type { WakeConfig } from "./fleet-config.js";
import { LaunchError, type ExecRecord, type LaunchSpec } from "./pty-host.js";

const REQUEST_TIMEOUT_MS = 15_000;

async function call<T>(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  if (res.status === 422) throw new LaunchError((parsed as { error?: string })?.error ?? "launch rejected");
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `${method} ${path} failed: ${res.status}`);
  return parsed as T;
}

export function launchRemote(baseUrl: string, token: string, spec: LaunchSpec): Promise<ExecRecord> {
  return call<ExecRecord>(baseUrl, token, "POST", "/exec/sessions", spec);
}

export async function killRemote(baseUrl: string, token: string, execId: string): Promise<void> {
  await call(baseUrl, token, "POST", `/exec/sessions/${encodeURIComponent(execId)}/kill`);
}

export async function wakeRemote(baseUrl: string, token: string, wake: WakeConfig): Promise<void> {
  await call(baseUrl, token, "POST", "/exec/wake", wake);
}

export function openRemoteStream(baseUrl: string, token: string, execId: string): WebSocket {
  const url = new URL(`/exec/sessions/${encodeURIComponent(execId)}/stream`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
}
