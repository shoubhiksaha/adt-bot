import { ArrowUp, Download, File, Folder, Loader2, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { computers, type FileEntry, type ReadResult } from "./api";
import { formatBytes, joinPath, parentPath } from "./logic";

/** Browse and edit files in a bot's computer; copy one to Downloads. */
export function FileBrowser({ botId, refreshKey }: { botId: string; refreshKey: number }) {
  const [dir, setDir] = useState("/workspace");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState<ReadResult | null>(null);
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState("");

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError("");
      try {
        const result = await computers.listFiles(botId, path);
        setDir(result.path);
        setEntries(result.entries);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [botId],
  );

  useEffect(() => {
    setOpen(null);
    void load("/workspace");
  }, [botId, load]);

  useEffect(() => {
    if (refreshKey) void load(dir);
    // Only on refreshKey changes (after a terminal command).
  }, [refreshKey]);

  const openFile = async (path: string) => {
    setError("");
    setNotice("");
    try {
      const file = await computers.read(botId, path);
      setOpen(file);
      setDraft(file.text);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = async (path: string, content: string) => {
    setError("");
    try {
      const result = await computers.write(botId, path, content);
      setNotice(`Saved ${result.path}`);
      void load(dir);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const download = async (path: string) => {
    setError("");
    try {
      const result = await computers.download(botId, path);
      setNotice(`Copied to ${result.path}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="computers-files" aria-label="Files">
      <div className="computers-files-bar">
        <button type="button" className="icon-btn" title="Up" aria-label="Up one folder" disabled={dir === "/"} onClick={() => void load(parentPath(dir))}>
          <ArrowUp size={15} />
        </button>
        <code className="grow computers-path">{dir}</code>
        {loading && <Loader2 size={14} className="spin" />}
        <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => void load(dir)}>
          <RefreshCw size={15} />
        </button>
      </div>
      {error && <div className="small error-text">{error}</div>}
      {notice && <div className="small muted">{notice}</div>}
      <ul className="computers-file-list">
        {entries.map((e) => {
          const path = joinPath(dir, e.name);
          return (
            <li key={e.name}>
              <button type="button" className="computers-file" onClick={() => (e.type === "dir" ? void load(path) : void openFile(path))}>
                {e.type === "dir" ? <Folder size={14} /> : <File size={14} />}
                <span className="grow">{e.name}</span>
                {e.type === "file" && <span className="small muted">{formatBytes(e.size)}</span>}
              </button>
              <button type="button" className="icon-btn" title="Copy to Downloads" aria-label={`Copy ${e.name} to Downloads`} onClick={() => void download(path)}>
                <Download size={14} />
              </button>
            </li>
          );
        })}
        {!entries.length && !loading && !error && <li className="small muted computers-file-empty">Empty folder</li>}
      </ul>
      <div className="computers-new-file">
        <input className="input" placeholder="New file name, e.g. notes.md" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button
          type="button"
          className="btn"
          disabled={!newName.trim() || newName.includes("/")}
          onClick={() => {
            const path = joinPath(dir, newName.trim());
            setNewName("");
            void save(path, "").then(() => void openFile(path));
          }}
        >
          Create
        </button>
      </div>
      {open && (
        <div className="computers-editor">
          <div className="computers-files-bar">
            <code className="grow computers-path">{open.path}</code>
            <span className="small muted">{formatBytes(open.size)}</span>
            <button type="button" className="btn" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          {open.binary ? (
            <p className="small muted">Binary file. Use the download button to copy it to this computer.</p>
          ) : (
            <>
              <textarea className="input computers-editor-text" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} readOnly={open.truncated} />
              <div className="btn-row">
                {open.truncated ? (
                  <span className="small muted">Showing the start of a large file (read-only here).</span>
                ) : (
                  <button type="button" className="btn primary" disabled={draft === open.text} onClick={() => void save(open.path, draft).then(() => setOpen({ ...open, text: draft }))}>
                    <Save size={14} /> Save
                  </button>
                )}
                <button type="button" className="btn" onClick={() => void download(open.path)}>
                  <Download size={14} /> Copy to Downloads
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
