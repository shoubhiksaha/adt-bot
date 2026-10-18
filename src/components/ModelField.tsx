import { RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import { listModels } from "../lib/llm";
import { updateProvider, useStore } from "../lib/store";
import type { ProviderConfig } from "../lib/types";

/** Free-text model id with suggestions from the provider, plus a live refresh from its /models endpoint. */
export function ModelField({
  provider,
  value,
  onChange,
}: {
  provider: ProviderConfig | undefined;
  value: string;
  onChange: (model: string) => void;
}) {
  const listId = useId();
  const useProxy = useStore((s) => s.settings.useProxy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      const models = await listModels(provider, useProxy);
      updateProvider(provider.id, { models });
      if (!value && models[0]) onChange(models[0].id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <label>Model</label>
      <div className="input-group">
        <input
          className="input"
          list={listId}
          value={value}
          placeholder="Type or pick a model id"
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="btn" onClick={() => void refresh()} disabled={!provider || busy} title="Fetch models">
          <RefreshCw size={14} className={busy ? "spin" : ""} /> Fetch
        </button>
      </div>
      <datalist id={listId}>
        {provider?.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name && m.name !== m.id ? m.name : ""}
          </option>
        ))}
      </datalist>
      {error && <span className="small error-text">{error}</span>}
    </div>
  );
}
