import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { expandHome } from "./pty-host.js";

// Monaco holds the whole buffer in memory and the payload crosses IPC/HTTP as
// one JSON string, so anything bigger is refused rather than half-opened.
export const MAX_FILE_BYTES = 2 * 1024 ** 2;

export class FileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 415,
  ) {
    super(message);
  }
}

export interface FileContent {
  path: string;
  content: string;
  // Round-tripped on save so a write can notice the file changed underneath
  // the editor (an agent in a sibling pane is the usual culprit).
  mtimeMs: number;
}

function resolvePath(path: string): string {
  const resolved = expandHome(path);
  if (!isAbsolute(resolved)) throw new FileError("path must be absolute", 400);
  return resolved;
}

export async function readTextFile(path: string): Promise<FileContent> {
  const resolved = resolvePath(path);
  const info = await stat(resolved).catch(() => null);
  if (!info) throw new FileError(`${resolved} does not exist`, 404);
  if (!info.isFile()) throw new FileError(`${resolved} is not a file`, 400);
  if (info.size > MAX_FILE_BYTES) throw new FileError(`${resolved} is larger than ${MAX_FILE_BYTES / 1024 ** 2} MB`, 413);

  const buf = await readFile(resolved);
  if (buf.includes(0)) throw new FileError(`${resolved} looks like a binary file`, 415);
  return { path: resolved, content: buf.toString("utf8"), mtimeMs: info.mtimeMs };
}

export async function writeTextFile(path: string, content: string, expectedMtimeMs?: number): Promise<FileContent> {
  const resolved = resolvePath(path);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new FileError("content is too large", 413);

  const existing = await stat(resolved).catch(() => null);
  if (existing && !existing.isFile()) throw new FileError(`${resolved} is not a file`, 400);
  if (existing && expectedMtimeMs !== undefined && existing.mtimeMs !== expectedMtimeMs) {
    throw new FileError(`${resolved} changed on disk since it was opened`, 409);
  }

  await writeFile(resolved, content, "utf8");
  return { path: resolved, content, mtimeMs: (await stat(resolved)).mtimeMs };
}

export interface DirEntry {
  name: string;
  kind: "dir" | "file";
}

export interface DirListing {
  path: string;
  // Null at the filesystem root.
  parent: string | null;
  entries: DirEntry[];
}

export async function listDirectory(path: string): Promise<DirListing> {
  const resolved = resolvePath(path);
  const info = await stat(resolved).catch(() => null);
  if (!info) throw new FileError(`${resolved} does not exist`, 404);
  if (!info.isDirectory()) throw new FileError(`${resolved} is not a directory`, 400);

  const dirents = await readdir(resolved, { withFileTypes: true }).catch(() => {
    throw new FileError(`cannot read ${resolved}`, 400);
  });
  // A symlink is classified by what it points at, so a linked directory can
  // be entered; a dangling one is listed as a file and fails on open.
  const entries = await Promise.all(
    dirents.map(async (d): Promise<DirEntry> => {
      const isDir = d.isDirectory() || (d.isSymbolicLink() && (await stat(`${resolved}/${d.name}`).catch(() => null))?.isDirectory());
      return { name: d.name, kind: isDir ? "dir" : "file" };
    }),
  );
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  const parent = dirname(resolved);
  return { path: resolved, parent: parent === resolved ? null : parent, entries };
}
