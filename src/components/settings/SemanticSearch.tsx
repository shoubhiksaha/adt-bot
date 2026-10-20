import { useEffect, useState } from "react";
import { EMBEDDING_MODEL } from "../../lib/embedding-model";
import {
  disableSemanticSearch,
  embeddingModelDownloaded,
  enableSemanticSearch,
  type IndexStatus,
  onEmbeddingProgress,
  onIndexStatus,
  removeSemanticSearch,
} from "../../lib/semantic";
import { useStore } from "../../lib/store";

/** "Smarter memory search": opt-in on-device embeddings for memories and knowledge files. */
export function SemanticSearchSetting() {
  const on = useStore((s) => s.settings.semanticSearch);
  const [downloaded, setDownloaded] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState<IndexStatus>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void embeddingModelDownloaded().then(setDownloaded);
  }, []);
  useEffect(() => onEmbeddingProgress(setProgress), []);
  useEffect(() => onIndexStatus(setIndexing), []);

  const turnOn = () => {
    setError("");
    setBusy(true);
    enableSemanticSearch()
      .then(() => setDownloaded(true))
      .catch((e: Error) => setError(`Couldn't download the model: ${e.message}`))
      .finally(() => {
        setBusy(false);
        setProgress(null);
      });
  };
  const turnOff = () => {
    setError("");
    void disableSemanticSearch();
  };

  let status = "";
  if (on && progress !== null) status = `Downloading… ${progress}%`;
  else if (on && busy) status = "Getting ready…";
  else if (on && indexing && indexing.total)
    status = `Indexing your memories and files… ${indexing.done.toLocaleString()} of ${indexing.total.toLocaleString()}`;
  else if (on && downloaded) status = "Ready: works offline.";

  return (
    <>
      <label className="toggle">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => (e.target.checked ? turnOn() : turnOff())} />
        <span>
          <strong>Smarter memory search (downloads {EMBEDDING_MODEL.mb} MB, works offline)</strong>
          <br />
          <span className="small muted">
            Finds memories and knowledge passages by meaning as well as by words, in 50+ languages: “what's my sister's name” finds “Riya is my
            sibling”. It runs on this device; your text never leaves it.
          </span>
        </span>
      </label>
      <div className="field" style={{ marginTop: -6 }}>
        {status && <span className="small muted">{status}</span>}
        {on && downloaded === false && !busy && (
          <div className="btn-row">
            <button type="button" className="btn" onClick={turnOn}>
              Download the model ({EMBEDDING_MODEL.mb} MB)
            </button>
            <span className="small muted">Until then, search matches words only.</span>
          </div>
        )}
        {!on && downloaded && (
          <button
            type="button"
            className="link-btn"
            style={{ alignSelf: "flex-start" }}
            onClick={() => void removeSemanticSearch().then(() => setDownloaded(false))}
          >
            Delete the downloaded model ({EMBEDDING_MODEL.mb} MB)
          </button>
        )}
        {error && <span className="small error-text">{error}</span>}
        <span className="small muted">Uses IBM's Granite Embedding 97M Multilingual R2 model (Apache-2.0).</span>
      </div>
    </>
  );
}
