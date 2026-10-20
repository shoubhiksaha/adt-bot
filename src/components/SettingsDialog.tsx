import { Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { canImagine, IMAGE_MODEL_SUGGESTIONS, resolveImageModel } from "../lib/imagine";
import { MOD } from "../lib/keys";
import { formatHeaders, parseHeaders } from "../lib/providers";
import { SEARCH_ENGINES, webSearch } from "../lib/search";
import { backupPasswordProblem } from "../lib/backup-crypto";
import {
  backupHasSealedKeys,
  eraseAllData,
  exportData,
  exportDataWithKeys,
  importChanges,
  importData,
  removeProvider,
  unlockBackup,
  updateProvider,
  updateSettings,
  useStore,
} from "../lib/store";
import { detectEnv, type Platform } from "../lib/transport";
import { Dialog } from "./Dialog";
import { ProviderSetup } from "./ProviderSetup";
import { AppearanceSettings } from "./settings/Appearance";
import { useFeatureRegistry } from "../features/registry";
import { ModelInput, Toggle } from "./settings/controls";
import { KeyStorageNote } from "./settings/KeyStorage";
import { ToolsSettings } from "./settings/ToolsSettings";
import { VoiceSettings } from "./settings/VoiceSettings";
import { WorkspaceSettings } from "./settings/Workspace";

export type SettingsTab = "general" | "appearance" | "workspace" | "providers" | "tools" | "search" | "images" | "voice" | "data" | (string & {});
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "workspace", label: "Workspace" },
  { id: "providers", label: "Providers" },
  { id: "tools", label: "Tools & safety" },
  { id: "search", label: "Search" },
  { id: "images", label: "Images" },
  { id: "voice", label: "Voice" },
  { id: "data", label: "Data" },
];

export default function SettingsDialog({ onClose, initialTab = "general" }: { onClose: () => void; initialTab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const featureTabs = useFeatureRegistry((s) => s.tabs);
  const [platform, setPlatform] = useState<Platform | null>(null);
  useEffect(() => {
    void detectEnv().then((env) => setPlatform(env.platform));
  }, []);
  const extra = featureTabs.filter((t) => !t.platforms || (platform && t.platforms.includes(platform)));
  const FeatureTab = extra.find((t) => t.id === tab)?.Component;
  return (
    <Dialog
      title="Settings"
      onClose={onClose}
      tabs={
        <div className="tabs" role="tablist">
          {[...TABS, ...extra.map((t) => ({ id: t.id, label: t.label }))].map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {tab === "general" && <GeneralTab />}
      {tab === "appearance" && <AppearanceSettings />}
      {tab === "workspace" && <WorkspaceSettings />}
      {tab === "providers" && <ProvidersTab />}
      {tab === "tools" && <ToolsSettings />}
      {FeatureTab && <FeatureTab />}
      {tab === "search" && <SearchTab />}
      {tab === "images" && <ImagesTab />}
      {tab === "voice" && <VoiceSettings />}
      {tab === "data" && <DataTab />}
    </Dialog>
  );
}

function GeneralTab() {
  const settings = useStore((s) => s.settings);
  const [platform, setPlatform] = useState<{ platform: Platform; proxy: boolean } | null>(null);
  useEffect(() => {
    void detectEnv().then(setPlatform);
  }, []);

  return (
    <div>
      <Toggle
        checked={settings.sendOnEnter}
        onChange={(v) => updateSettings({ sendOnEnter: v })}
        title="Send with Enter"
        hint="Shift+Enter adds a new line. On touch screens the send button is used."
      />
      <Toggle
        checked={settings.smartTitles}
        onChange={(v) => updateSettings({ smartTitles: v })}
        title="Smart chat titles"
        hint="Name each chat from its first exchange (one tiny extra request)."
      />
      <Toggle
        checked={settings.useProxy}
        onChange={(v) => updateSettings({ useProxy: v })}
        title="Use the built-in relay"
        hint={`Avoids browser CORS blocks for providers, local and private servers. ${
          platform
            ? platform.proxy
              ? "A relay is available here."
              : platform.platform === "web"
                ? "No relay here (static hosting), so requests go straight from the browser."
                : "Mobile apps send requests natively."
            : ""
        }`}
      />
      <div className="field-label" style={{ marginTop: 8 }}>
        Keyboard shortcuts
      </div>
      <table className="shortcuts">
        <tbody>
          <tr><td><kbd>{MOD}K</kbd></td><td>Search chats</td></tr>
          <tr><td><kbd>{MOD}Shift+O</kbd></td><td>New chat</td></tr>
          <tr><td><kbd>/</kbd></td><td>Focus the message box</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Stop the reply</td></tr>
          <tr><td><kbd>{MOD}Enter</kbd></td><td>Send an edited message</td></tr>
        </tbody>
      </table>
      {platform && <p className="small muted">Running on: {platform.platform}</p>}
    </div>
  );
}

function ProvidersTab() {
  const providers = useStore((s) => s.providers);
  const [adding, setAdding] = useState(providers.length === 0);

  return (
    <div>
      {providers.map((p) => (
        <div className="card" key={p.id}>
          <div className="card-row">
            <div className="grow">
              <strong>{p.name}</strong>
              <div className="small muted ellipsis">
                {p.baseUrl} · {p.models.length} models
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              title="Remove provider"
              onClick={() => confirm(`Remove ${p.name}? Bots using it will need a new provider.`) && removeProvider(p.id)}
            >
              <Trash2 size={16} />
            </button>
          </div>
          <div className="field-row" style={{ marginTop: 10 }}>
            <input className="input" type="password" placeholder="API key" value={p.apiKey} onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })} />
            <input className="input" placeholder="Base URL" value={p.baseUrl} onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })} />
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="small muted" style={{ cursor: "pointer" }}>
              Extra headers{p.headers ? ` (${Object.keys(p.headers).length})` : ""}
            </summary>
            <textarea
              className="textarea"
              style={{ minHeight: 60, marginTop: 6 }}
              spellCheck={false}
              placeholder="Name: value, one per line"
              defaultValue={formatHeaders(p.headers)}
              onBlur={(e) => updateProvider(p.id, { headers: parseHeaders(e.target.value) })}
            />
          </details>
        </div>
      ))}
      <KeyStorageNote warningsOnly />
      {adding ? (
        <ProviderSetup onDone={() => setAdding(false)} />
      ) : (
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          <Plus size={15} /> Add provider
        </button>
      )}
    </div>
  );
}

function SearchTab() {
  const search = useStore((s) => s.settings.search);
  const useProxy = useStore((s) => s.settings.useProxy);
  const [test, setTest] = useState<{ busy?: boolean; text?: string; ok?: boolean }>({});
  const engine = SEARCH_ENGINES.find((e) => e.id === search.engine)!;
  const set = (patch: Partial<typeof search>) => updateSettings({ search: { ...search, ...patch } });

  const runTest = async () => {
    setTest({ busy: true });
    try {
      const results = await webSearch("latest news today", { ...search, readPages: false }, useProxy);
      setTest({ ok: results.length > 0, text: results.length ? `Works: ${results.length} results, e.g. “${results[0].title}”` : "No results came back." });
    } catch (error) {
      setTest({ ok: false, text: (error as Error).message });
    }
  };

  return (
    <div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Turn on <strong>Search</strong> under the message box (or type /search) and any model, including local ones, answers with fresh web results and numbered sources.
      </p>
      <Toggle
        checked={search.native}
        onChange={(v) => set({ native: v })}
        title="Use the model's built-in search when available"
        hint="Gemini (Google Search), Claude, OpenRouter and Perplexity can search the web themselves: more reliable, billed by that provider. Other models use the engine below."
      />
      <div className="field-label">Search engine for other models</div>
      <div style={{ height: 6 }} />
      <div className="radio-cards">
        {SEARCH_ENGINES.map((e) => (
          <label key={e.id} className={`radio-card${search.engine === e.id ? " active" : ""}`}>
            <input type="radio" name="engine" checked={search.engine === e.id} onChange={() => set({ engine: e.id })} />
            <span>
              <strong>{e.name}</strong>
              <br />
              <span className="small muted">{e.help}</span>
            </span>
          </label>
        ))}
      </div>
      {engine.needs === "key" && (
        <div className="field">
          <label htmlFor="search-key">{engine.name} API key</label>
          <input id="search-key" className="input" type="password" value={search.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
        </div>
      )}
      {engine.needs === "url" && (
        <div className="field">
          <label htmlFor="search-url">SearXNG address</label>
          <input id="search-url" className="input" placeholder="http://192.168.1.20:8888" value={search.url} onChange={(e) => set({ url: e.target.value })} />
        </div>
      )}
      <Toggle
        checked={search.readPages}
        onChange={(v) => set({ readPages: v })}
        title="Read the top pages"
        hint="Fetches the top 3 results for detailed, well-cited answers (uses more tokens)."
      />
      <div className="btn-row">
        <button type="button" className="btn" disabled={test.busy} onClick={() => void runTest()}>
          {test.busy && <Loader2 size={14} className="spin" />} Test search
        </button>
      </div>
      {test.text && <div className={`status ${test.ok ? "ok" : "err"}`}>{test.text}</div>}
    </div>
  );
}

function ImagesTab() {
  const providers = useStore((s) => s.providers);
  const image = useStore((s) => s.settings.image);
  const auto = resolveImageModel(providers, { providerId: "", model: "" });
  const capable = providers.filter(canImagine);
  const chosen = providers.find((p) => p.id === image.providerId);
  const suggestions = chosen
    ? [...(IMAGE_MODEL_SUGGESTIONS[chosen.presetId] ?? []), ...chosen.models.map((m) => m.id).filter((id) => /image|imagine|flux|dall|diffusion|sdxl|seedream|recraft|imagen/i.test(id))]
    : [];

  return (
    <div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Turn on <strong>Imagine</strong> under the message box, or type <code>/imagine a cat in a spacesuit</code>.
      </p>
      <div className="field">
        <label htmlFor="image-provider">Image provider</label>
        <select
          id="image-provider"
          className="select"
          value={image.providerId}
          onChange={(e) => {
            const provider = providers.find((p) => p.id === e.target.value);
            updateSettings({ image: { providerId: e.target.value, model: IMAGE_MODEL_SUGGESTIONS[provider?.presetId ?? ""]?.[0] ?? "" } });
          }}
        >
          <option value="">Automatic{auto ? ` (${auto.provider.name} · ${auto.model})` : " (connect OpenRouter, OpenAI, xAI or Gemini)"}</option>
          {capable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {chosen && (
        <div className="field">
          <label>Image model</label>
          <ModelInput
            value={image.model}
            onChange={(model) => updateSettings({ image: { ...image, model } })}
            suggestions={suggestions}
            placeholder="e.g. gpt-image-2 or black-forest-labs/flux.2-pro"
          />
          <span className="small muted">
            OpenRouter and Gemini image models, plus any server with an OpenAI-style /images/generations endpoint (OpenAI, xAI, Together, LocalAI…).
          </span>
        </div>
      )}
    </div>
  );
}

function DataTab() {
  const [message, setMessage] = useState<string | null>(null);
  // "Export with keys": the keys in the file are sealed with this password.
  const [sealing, setSealing] = useState<{ password: string; confirm: string; busy?: boolean } | null>(null);
  // A chosen backup whose keys are password-protected, waiting for its password.
  const [unlocking, setUnlocking] = useState<{ text: string; password: string; busy?: boolean } | null>(null);

  const save = async (json: string) => {
    const name = `adt-bot-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: "application/json" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name }).catch(() => undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportSealed = async () => {
    if (!sealing) return;
    setSealing({ ...sealing, busy: true });
    try {
      await save(await exportDataWithKeys(sealing.password));
      setSealing(null);
      setMessage("Backup saved. Its keys open only with the password you chose.");
    } catch (error) {
      setSealing({ ...sealing, busy: false });
      setMessage((error as Error).message);
    }
  };

  const finishImport = (text: string) => {
    // A backup from someone else could point your providers at their server.
    const changes = importChanges(text);
    if (
      changes.length &&
      !window.confirm(
        `This backup sends your chats to these addresses:\n\n${changes.slice(0, 8).join("\n")}\n\nOnly import backups you made yourself. Import anyway?`,
      )
    ) {
      setMessage("Import cancelled.");
      return;
    }
    importData(text);
    setMessage("Backup imported.");
  };

  const importLocked = async (withKeys: boolean) => {
    if (!unlocking) return;
    try {
      if (!withKeys) {
        setUnlocking(null);
        finishImport(unlocking.text);
        return;
      }
      setUnlocking({ ...unlocking, busy: true });
      const text = await unlockBackup(unlocking.text, unlocking.password);
      setUnlocking(null);
      finishImport(text);
    } catch (error) {
      setUnlocking({ ...unlocking, busy: false });
      setMessage((error as Error).message);
    }
  };

  const sealProblem = sealing ? backupPasswordProblem(sealing.password, sealing.confirm) : "";

  return (
    <div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Everything (bots, memory, chats, keys) lives only on this device. Export a backup to move it to another device.
      </p>
      <KeyStorageNote />
      <div className="btn-row" style={{ marginBottom: 16 }}>
        <button type="button" className="btn" onClick={() => void save(exportData())}>
          Export (without keys)
        </button>
        <button type="button" className="btn" onClick={() => setSealing(sealing ? null : { password: "", confirm: "" })}>
          Export with keys…
        </button>
        <label className="btn">
          Import backup
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setMessage(null);
              try {
                const text = await file.text();
                if (backupHasSealedKeys(text)) setUnlocking({ text, password: "" });
                else finishImport(text);
              } catch (error) {
                setMessage((error as Error).message);
              }
            }}
          />
        </label>
      </div>
      {sealing && (
        <div className="card">
          <p className="small" style={{ marginTop: 0 }}>
            The keys in the file are encrypted with this password (AES-256). You'll need it to import them, and it can't be recovered.
          </p>
          <div className="field-row">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder="Password"
              value={sealing.password}
              onChange={(e) => setSealing({ ...sealing, password: e.target.value })}
            />
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder="Same password again"
              value={sealing.confirm}
              onChange={(e) => setSealing({ ...sealing, confirm: e.target.value })}
            />
          </div>
          {sealing.password && sealProblem && <p className="status err">{sealProblem}</p>}
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button type="button" className="btn primary" disabled={Boolean(sealProblem) || sealing.busy} onClick={() => void exportSealed()}>
              {sealing.busy && <Loader2 size={14} className="spin" />} Export with keys
            </button>
            <button type="button" className="btn" onClick={() => setSealing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {unlocking && (
        <div className="card">
          <p className="small" style={{ marginTop: 0 }}>
            This backup's keys are protected with a password.
          </p>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder="Backup password"
            value={unlocking.password}
            onChange={(e) => setUnlocking({ ...unlocking, password: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && unlocking.password && !unlocking.busy) void importLocked(true);
            }}
          />
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button type="button" className="btn primary" disabled={!unlocking.password || unlocking.busy} onClick={() => void importLocked(true)}>
              {unlocking.busy && <Loader2 size={14} className="spin" />} Import with keys
            </button>
            <button type="button" className="btn" disabled={unlocking.busy} onClick={() => void importLocked(false)}>
              Import without keys
            </button>
            <button type="button" className="btn" disabled={unlocking.busy} onClick={() => setUnlocking(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && <p className="small">{message}</p>}
      <button
        type="button"
        className="btn danger"
        onClick={async () => {
          if (confirm("Delete all bots, chats, memory and keys from this device?")) {
            await eraseAllData();
            location.reload();
          }
        }}
      >
        <Trash2 size={14} /> Erase all data
      </button>
    </div>
  );
}
