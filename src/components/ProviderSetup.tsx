import { Check, ChevronDown, Cpu, ExternalLink, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isDesktop } from "../lib/desktop";
import { detectLocalServers, type FoundServer } from "../lib/detect";
import { listModels } from "../lib/llm";
import { PROVIDER_PRESETS, parseHeaders, presetById, type ProviderPreset } from "../lib/providers";
import { addProvider, updateProvider, useStore } from "../lib/store";
import type { ModelInfo, ProviderConfig } from "../lib/types";

const POPULAR = ["xai", "openai", "anthropic", "google", "openrouter", "groq"];
const GROUPS: { group: ProviderPreset["group"]; label: string }[] = [
  { group: "cloud", label: "Cloud providers" },
  { group: "local", label: "Local AI on this computer (no key)" },
  { group: "private", label: "Private, self-hosted or custom servers" },
  { group: "cli", label: "Coding agents on this computer (command-line tools)" },
];

/** The model a new provider's bots start with: the preset default, or the first installed model. */
function pickModel(preset: ProviderPreset, found: ModelInfo[] | null): string | undefined {
  const installed = found?.some((m) => m.id === preset.defaultModel);
  if (preset.local && found?.length && !installed) return found[0].id;
  return preset.defaultModel || found?.[0]?.id;
}

export function ProviderSetup({ onDone }: { onDone?: (provider: ProviderConfig) => void }) {
  const useProxy = useStore((s) => s.settings.useProxy);
  const connected = useStore((s) => s.providers);
  const [presetId, setPresetId] = useState("xai");
  const preset = presetById(presetId) as ProviderPreset;
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [headersText, setHeadersText] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [found, setFound] = useState<FoundServer[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void detectLocalServers(useProxy).then((servers) => !cancelled && setFound(servers));
    return () => {
      cancelled = true;
    };
  }, [useProxy]);

  const choose = (id: string) => {
    const next = presetById(id)!;
    setPresetId(id);
    setBaseUrl(next.baseUrl);
    setStatus(null);
    setFailed(false);
  };

  const draft = (url = baseUrl): ProviderConfig => ({
    id: "draft",
    presetId,
    name: preset.name,
    kind: preset.kind,
    baseUrl: url.trim(),
    apiKey: apiKey.trim(),
    models: [],
    headers: parseHeaders(headersText),
  });

  /** Lists models, retrying with "/v1" appended when the user pasted a bare host like http://10.0.0.5:11434. */
  const fetchModels = async (): Promise<{ models: ModelInfo[]; base: string }> => {
    const base = baseUrl.trim().replace(/\/+$/, "");
    try {
      return { models: await listModels(draft(base), useProxy), base };
    } catch (error) {
      if (preset.kind !== "openai" || /\/(v\d+|api)$/.test(base)) throw error;
      try {
        const withV1 = `${base}/v1`;
        const models = await listModels(draft(withV1), useProxy);
        setBaseUrl(withV1);
        return { models, base: withV1 };
      } catch {
        throw error;
      }
    }
  };

  const save = (models: ModelInfo[] | null, base: string) => {
    const provider = addProvider(presetId, apiKey, base, pickModel(preset, models), parseHeaders(headersText));
    if (models?.length) updateProvider(provider.id, { models });
    onDone?.({ ...provider, models: models?.length ? models : provider.models });
  };

  const connect = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const { models, base } = await fetchModels();
      if (preset.local && !models.length) {
        setStatus({ ok: false, text: "Connected, but no models are installed yet (e.g. run `ollama pull llama3.2`)." });
        setFailed(true);
        return;
      }
      save(models, base);
    } catch (error) {
      setStatus({ ok: false, text: (error as Error).message });
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const useFound = (server: FoundServer) => {
    if (connected.some((p) => p.baseUrl === server.preset.baseUrl)) return;
    const provider = addProvider(server.preset.id, "", server.preset.baseUrl, pickModel(server.preset, server.models));
    updateProvider(provider.id, { models: server.models });
    onDone?.({ ...provider, models: server.models });
  };

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return PROVIDER_PRESETS.filter((p) => (p.kind !== "cli" || isDesktop()) && (!q || p.name.toLowerCase().includes(q) || p.id.includes(q)));
  }, [filter]);

  const showUrl = (preset.group !== "cloud" && preset.group !== "cli") || !preset.baseUrl;
  const canConnect = Boolean(baseUrl.trim()) && (!preset.needsKey || apiKey.trim().length > 0) && !busy;

  const tile = (p: ProviderPreset) => (
    <button key={p.id} type="button" className={p.id === presetId ? "active" : ""} onClick={() => choose(p.id)}>
      {p.name}
      {connected.some((c) => c.presetId === p.id) && <Check size={13} className="tile-check" aria-label="Connected" />}
    </button>
  );

  return (
    <div className="provider-setup">
      {found && found.length > 0 && (
        <div className="found">
          <div className="field-label">
            <Cpu size={14} /> Found on this computer
          </div>
          {found.map((server) => {
            const added = connected.some((p) => p.baseUrl === server.preset.baseUrl);
            return (
              <div className="card found-card" key={server.preset.id}>
                <div className="grow">
                  <strong>{server.preset.name.replace(" (local)", "")}</strong>
                  <div className="small muted">
                    {server.models.length
                      ? `${server.models.length} model${server.models.length === 1 ? "" : "s"}: ${server.models.slice(0, 3).map((m) => m.id).join(", ")}${server.models.length > 3 ? "…" : ""}`
                      : "Running, but no models installed yet"}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={added || !server.models.length}
                  onClick={() => useFound(server)}
                >
                  {added ? "Added" : "Use"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="field-label">{found?.length ? "Or connect a provider" : "Connect a provider"}</div>
      <div style={{ height: 6 }} />
      <div className="provider-grid">{POPULAR.map((id) => tile(presetById(id)!))}</div>

      <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
        <ChevronDown size={14} style={{ transform: showAll ? "rotate(180deg)" : undefined }} />{" "}
        {showAll ? "Fewer options" : "More providers, local AI & private servers"}
      </button>
      {showAll && (
        <div className="all-providers">
          <label className="search-box">
            <Search size={15} className="muted" />
            <input placeholder="Search providers" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          {GROUPS.map(({ group, label }) => {
            const items = visible.filter((p) => p.group === group);
            return items.length ? (
              <div key={group}>
                <div className="field-label">{label}</div>
                <div style={{ height: 6 }} />
                <div className="provider-grid">{items.map(tile)}</div>
              </div>
            ) : null;
          })}
        </div>
      )}

      <div className="card connect-card">
        <div className="connect-title">
          <strong>{preset.name}</strong>
          {preset.keyUrl && (
            <a className="small" href={preset.keyUrl} target="_blank" rel="noreferrer">
              Get a key <ExternalLink size={12} />
            </a>
          )}
        </div>
        {(preset.needsKey || (preset.group !== "local" && preset.group !== "cli")) && (
          <div className="field">
            <label htmlFor="api-key">
              API key {!preset.needsKey && <span className="badge">optional</span>}
            </label>
            <input
              id="api-key"
              className="input"
              type="password"
              autoComplete="off"
              placeholder={preset.needsKey ? "Paste your key" : "Leave empty if your server has no key"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canConnect && void connect()}
            />
          </div>
        )}
        {showUrl ? (
          <div className="field">
            <label htmlFor="base-url">Server address</label>
            <input
              id="base-url"
              className="input"
              placeholder="http://192.168.1.50:11434 or https://llm.example.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {preset.note && <span className="small muted">{preset.note}</span>}
          </div>
        ) : (
          preset.note && <p className="small muted">{preset.note}</p>
        )}
        <details className="field advanced" open={preset.group === "private" || undefined}>
          <summary className="field-label">Advanced</summary>
          {!showUrl && (
            <div className="field" style={{ marginTop: 8 }}>
              <label htmlFor="base-url-adv">Base URL</label>
              <input id="base-url-adv" className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </div>
          )}
          <label className="field-label" htmlFor="headers" style={{ marginTop: 8, display: "block" }}>
            Extra headers <span className="badge">optional</span>
          </label>
          <textarea
            id="headers"
            className="textarea"
            style={{ minHeight: 64, marginTop: 6 }}
            spellCheck={false}
            placeholder={"One per line, for servers behind a login, e.g.\nAuthorization: Basic dXNlcjpwYXNz\nCF-Access-Client-Id: …"}
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
          />
        </details>
        <div className="btn-row">
          <button type="button" className="btn primary" disabled={!canConnect} onClick={() => void connect()}>
            {busy && <Loader2 size={14} className="spin" />} {busy ? "Connecting…" : "Connect"}
          </button>
          {failed && !busy && (
            <button type="button" className="btn" onClick={() => save(null, baseUrl)}>
              Save anyway
            </button>
          )}
        </div>
        {status && <div className={`status ${status.ok ? "ok" : "err"}`}>{status.text}</div>}
        <p className="small muted" style={{ marginBottom: 0 }}>
          Keys stay on this device and are only sent to the provider you choose.
        </p>
      </div>
    </div>
  );
}
