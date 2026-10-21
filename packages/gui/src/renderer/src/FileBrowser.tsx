import { useEffect, useRef, useState } from "react";
import { ArrowUp, File as FileIcon, Folder } from "lucide-react";
import type { DirListing } from "../../shared/types.js";

// Directory browser: a path bar over the listing. Clicking a folder enters
// it, a file opens it. `host` is the machine whose disk is browsed; changing
// it re-lists, falling back to ~ when the current directory doesn't exist
// there. Used as the Editor launcher's picker (`onCancel` set) and as the
// editor pane's persistent sidebar (`activePath` set).
export default function FileBrowser({
  host,
  startDir,
  activePath,
  onOpen,
  onCancel,
}: {
  host: string | null;
  startDir: string;
  activePath?: string;
  onOpen: (path: string) => void;
  onCancel?: () => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [pathInput, setPathInput] = useState(startDir);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const go = async (path: string, fallback?: string) => {
    const request = ++requestRef.current;
    let res = await window.api.listDirectory(host, path);
    if (!res.ok && fallback) res = await window.api.listDirectory(host, fallback);
    if (request !== requestRef.current) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setListing(res.result);
    setPathInput(res.result.path);
  };

  useEffect(() => {
    void go(listing?.path ?? startDir, "~");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const join = (name: string) => `${listing!.path.replace(/\/$/, "")}/${name}`;

  return (
    <div className="file-browser">
      <div className="file-browser-bar">
        <button title="Parent folder" disabled={!listing?.parent} onClick={() => listing?.parent && void go(listing.parent)}>
          <ArrowUp size={13} />
        </button>
        <input
          className="pane-launcher-args"
          value={pathInput}
          placeholder="/absolute/path"
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go(pathInput.trim());
            if (e.key === "Escape") onCancel?.();
          }}
        />
        {onCancel && <button onClick={onCancel}>Cancel</button>}
      </div>
      {error && <p className="status status-down">{error}</p>}
      <div className="file-browser-list">
        {listing?.entries.map((entry) => {
          const path = join(entry.name);
          return (
            <button
              key={entry.name}
              className={`file-browser-entry ${path === activePath ? "active" : ""}`}
              onClick={() => (entry.kind === "dir" ? void go(path) : onOpen(path))}
            >
              {entry.kind === "dir" ? <Folder size={13} /> : <FileIcon size={13} />}
              {entry.name}
            </button>
          );
        })}
        {listing && listing.entries.length === 0 && <p className="status status-pending">Empty folder</p>}
      </div>
    </div>
  );
}
