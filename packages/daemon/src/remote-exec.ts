// The control plane's side of /exec/* (routes/exec.ts) on another host.
import { WebSocket } from "ws";
import type { WakeConfig } from "./fleet-config.js";
import type { DirListing, FileContent } from "./files.js";
import { LaunchError, type ExecRecord, type LaunchSpec } from "./pty-host.js";

const REQUEST_TIMEOUT_MS = 15_000;

// A file route's own refusal on the peer, passed through with its status so
// the control plane can relay it instead of flattening it to a 500.
export class RemoteFileError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

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
  if (!res.ok && path.startsWith("/exec/files")) {
    throw new RemoteFileError((parsed as { error?: string })?.error ?? `${method} ${path} failed`, res.status);
  }
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

export function readFileRemote(baseUrl: string, token: string, path: string): Promise<FileContent> {
  return call<FileContent>(baseUrl, token, "GET", `/exec/files?path=${encodeURIComponent(path)}`);
}

export function writeFileRemote(
  baseUrl: string,
  token: string,
  body: { path: string; content: string; expectedMtimeMs?: number },
): Promise<FileContent> {
  return call<FileContent>(baseUrl, token, "PUT", "/exec/files", body);
}

export function listDirectoryRemote(baseUrl: string, token: string, path: string): Promise<DirListing> {
  return call<DirListing>(baseUrl, token, "GET", `/exec/files/list?path=${encodeURIComponent(path)}`);
}
