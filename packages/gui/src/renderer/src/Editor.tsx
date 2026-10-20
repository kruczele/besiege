import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { PaneEditor } from "../../shared/types.js";

// Only the core editor worker is bundled: syntax highlighting comes from the
// basic-languages tokenizers, while the TS/JSON/CSS language-service workers
// (several MB) are left out.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.editor.defineTheme("besiege", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#1b1e27", "editor.foreground": "#e7e8ed" },
});

type Status = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

export default function EditorView({ editor }: { editor: PaneEditor }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const mtimeRef = useRef<number | undefined>(undefined);
  const savedRef = useRef("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const save = async (force = false) => {
    const instance = instanceRef.current;
    if (!instance) return;
    const content = instance.getValue();
    const res = await window.api.writeFile(editor.host, editor.path, content, force ? undefined : mtimeRef.current);
    if (!res.ok) {
      setNote(res.error);
      return;
    }
    mtimeRef.current = res.result.mtimeMs;
    savedRef.current = content;
    setDirty(false);
    setNote(null);
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    setStatus({ kind: "loading" });
    setDirty(false);
    setNote(null);

    const instance = monaco.editor.create(container, {
      theme: "besiege",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'Menlo, "SF Mono", Monaco, Consolas, "DejaVu Sans Mono", monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    instanceRef.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
    const changeSub = instance.onDidChangeModelContent(() => setDirty(instance.getValue() !== savedRef.current));

    void window.api.readFile(editor.host, editor.path).then((res) => {
      if (disposed) return;
      if (!res.ok) {
        setStatus({ kind: "error", message: res.error });
        return;
      }
      mtimeRef.current = res.result.mtimeMs;
      savedRef.current = res.result.content;
      const model = monaco.editor.createModel(res.result.content, undefined, monaco.Uri.file(res.result.path));
      instance.setModel(model);
      setStatus({ kind: "ready" });
    });

    return () => {
      disposed = true;
      changeSub.dispose();
      instance.getModel()?.dispose();
      instance.dispose();
      instanceRef.current = null;
    };
  }, [editor.host, editor.path]);

  return (
    <div className="pane-editor">
      <div className="pane-editor-bar">
        <span className="pane-editor-path" title={editor.path}>
          {dirty && "● "}
          {editor.host ? `${editor.host}:` : ""}
          {editor.path}
        </span>
        {note && (
          <span className="pane-editor-note" title={note}>
            {note}
          </span>
        )}
        {note?.includes("changed on disk") && (
          <button onClick={() => void save(true)}>Overwrite</button>
        )}
        <button disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
      </div>
      {status.kind === "error" && <p className="status status-down">{status.message}</p>}
      <div className="pane-editor-monaco" ref={containerRef} hidden={status.kind === "error"} />
    </div>
  );
}
