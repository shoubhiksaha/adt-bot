import { Download, Globe, ImagePlus, Loader2, RotateCcw, Sparkles, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { brandFromFile, brandFromTextWithAI, brandFromWebsite, type BrandSuggestion } from "../../lib/brand-import";
import { DEFAULT_THEME, defaultSettings, updateSettings, useStore } from "../../lib/store";
import { FONTS, normalizeHex, preferredMode, THEME_PRESETS } from "../../lib/theme";
import type { Brand, ThemeConfig } from "../../lib/types";
import { Section, Toggle } from "./controls";

const BRAND_FILES = "image/*,.svg,.pdf,.docx,.css,.scss,.less,.json,.html,.htm,.md,.txt,.xml,.yaml,.yml,.ase,.tokens";

export function AppearanceSettings() {
  const brand = useStore((s) => s.settings.brand);
  const mode = useStore((s) => s.settings.theme);
  const useProxy = useStore((s) => s.settings.useProxy);
  const [busy, setBusy] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<BrandSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [website, setWebsite] = useState("");
  const logoInput = useRef<HTMLInputElement>(null);
  const kitInput = useRef<HTMLInputElement>(null);

  const setBrand = (patch: Partial<Brand>) => updateSettings({ brand: { ...brand, ...patch } });
  const setTheme = (patch: Partial<ThemeConfig>) => setBrand({ theme: { ...brand.theme, ...patch } });

  const run = async (label: string, task: () => Promise<BrandSuggestion>) => {
    setBusy(label);
    setError(null);
    try {
      const result = await task();
      setSuggestion(result);
      if (!result.accent && !result.logo && !result.palette.length && !result.name) {
        setError(result.text ? "No colours found in that file. Try “Ask AI” to read the brand guide." : "Couldn't find any brand colours in that file.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const apply = (s: BrandSuggestion) => {
    const theme: ThemeConfig = {
      ...brand.theme,
      preset: "custom",
      accent: s.accent ?? brand.theme.accent,
      background: s.background ?? brand.theme.background,
      font: s.font ? matchFont(s.font) : brand.theme.font,
    };
    setBrand({ name: s.name?.slice(0, 40) || brand.name, logo: s.logo ?? brand.logo, theme });
    const preferred = preferredMode(theme);
    if (preferred && mode === "system") updateSettings({ theme: preferred });
  };

  const exportKit = () => {
    const blob = new Blob([JSON.stringify({ app: "adt-bot-brand", version: 1, ...brand }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(brand.name || "brand").replace(/[^\w-]+/g, "-").toLowerCase()}-brand-kit.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div>
      <Section title="Name & logo">
        <div className="brand-row">
          <button type="button" className="logo-drop" onClick={() => logoInput.current?.click()} title="Upload logo">
            {brand.logo ? <img src={brand.logo} alt="Logo" /> : <img src="./icon.svg" alt="Default logo" />}
            <span className="logo-edit">
              <ImagePlus size={14} />
            </span>
          </button>
          <div className="grow">
            <div className="field" style={{ marginBottom: 8 }}>
              <label htmlFor="brand-name">App name</label>
              <input
                id="brand-name"
                className="input"
                maxLength={40}
                value={brand.name}
                onChange={(e) => setBrand({ name: e.target.value })}
                onBlur={(e) => !e.target.value.trim() && setBrand({ name: defaultSettings.brand.name })}
              />
            </div>
            <div className="btn-row">
              <button type="button" className="btn" onClick={() => logoInput.current?.click()}>
                <Upload size={14} /> Upload logo
              </button>
              {brand.logo && (
                <button type="button" className="btn" onClick={() => setBrand({ logo: "", logoAsAvatar: false })}>
                  <X size={14} /> Remove
                </button>
              )}
            </div>
          </div>
          <input
            ref={logoInput}
            type="file"
            accept="image/*,.svg"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              // Use the logo straight away, and offer its colours as a theme.
              if (file)
                void run("logo", async () => {
                  const found = await brandFromFile(file);
                  if (found.logo) setBrand({ logo: found.logo });
                  return { ...found, logo: undefined, source: "your logo" };
                });
            }}
          />
        </div>
        {brand.logo && (
          <Toggle
            checked={brand.logoAsAvatar}
            onChange={(v) => setBrand({ logoAsAvatar: v })}
            title="Use the logo as the main bot's picture"
            hint="Shows your logo next to the first bot's replies."
          />
        )}
      </Section>

      <Section title="Match my brand" hint="Drop a logo, brand guide (PDF/Word), CSS or design-tokens file, or enter your website. Colours, logo and name are picked up automatically.">
        <label
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) void run("file", () => brandFromFile(file));
          }}
        >
          {busy === "file" || busy === "logo" ? <Loader2 size={18} className="spin" /> : <Upload size={18} />}
          <div>
            <strong>{busy === "file" ? "Reading…" : "Drop a brand file"}</strong>
            <div className="small muted">Logo, brand guide, CSS, tokens JSON, HTML, any document</div>
          </div>
          <input
            type="file"
            hidden
            accept={BRAND_FILES}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void run("file", () => brandFromFile(file));
            }}
          />
        </label>
        <form
          className="input-group"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (website.trim()) void run("web", () => brandFromWebsite(website.trim(), useProxy));
          }}
        >
          <input className="input" placeholder="yourcompany.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
          <button type="submit" className="btn" disabled={!website.trim() || busy !== null}>
            {busy === "web" ? <Loader2 size={14} className="spin" /> : <Globe size={14} />} From website
          </button>
        </form>
        {error && <div className="small error-text" style={{ marginTop: 6 }}>{error}</div>}

        {suggestion && (
          <div className="card suggestion">
            <div className="suggestion-head">
              {suggestion.logo && <img src={suggestion.logo} alt="" className="suggestion-logo" />}
              <div className="grow">
                <strong>{suggestion.name || "Found in " + suggestion.source}</strong>
                <div className="small muted">
                  {suggestion.palette.length ? "Click a colour to use it, or apply the suggestion." : "No colours found."}
                  {suggestion.font && ` Font: ${suggestion.font}.`}
                </div>
              </div>
            </div>
            {suggestion.palette.length > 0 && (
              <div className="swatches">
                {suggestion.palette.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`swatch${color === suggestion.accent ? " chosen" : ""}`}
                    style={{ background: color }}
                    title={`Use ${color} as the brand colour`}
                    onClick={() => setSuggestion({ ...suggestion, accent: color })}
                  />
                ))}
              </div>
            )}
            <div className="btn-row" style={{ marginTop: 10 }}>
              {(suggestion.accent || suggestion.logo || suggestion.name) && (
                <button type="button" className="btn primary" onClick={() => apply(suggestion)}>
                  Apply{suggestion.logo ? " logo," : ""} {suggestion.name ? "name, " : ""}colours
                </button>
              )}
              {suggestion.text && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => void run("ai", () => brandFromTextWithAI(suggestion.text!))}
                >
                  {busy === "ai" ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Ask AI to read the brand guide
                </button>
              )}
              <button type="button" className="btn" onClick={() => setSuggestion(null)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Theme">
        <div className="theme-grid">
          {THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`theme-tile${brand.theme.preset === preset.id ? " active" : ""}`}
              onClick={() => {
                setTheme({ preset: preset.id, accent: preset.accent, background: preset.background });
                const preferred = preferredMode({ ...brand.theme, background: preset.background });
                if (preferred) updateSettings({ theme: preferred });
              }}
            >
              <span className="theme-preview" style={{ background: preset.background || "linear-gradient(135deg, #0b0c0e 50%, #fafaf8 50%)" }}>
                <span style={{ background: preset.accent }} />
              </span>
              {preset.name}
            </button>
          ))}
        </div>

        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="accent">Brand colour</label>
            <div className="input-group">
              <input
                type="color"
                aria-label="Pick brand colour"
                value={normalizeHex(brand.theme.accent) ?? "#3b82f6"}
                onChange={(e) => setTheme({ accent: e.target.value, preset: "custom" })}
              />
              <input
                id="accent"
                className="input"
                defaultValue={brand.theme.accent}
                key={brand.theme.accent}
                onBlur={(e) => {
                  const hex = normalizeHex(e.target.value);
                  if (hex) setTheme({ accent: hex, preset: "custom" });
                }}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="bg">Page colour</label>
            <div className="input-group">
              <input
                type="color"
                aria-label="Pick page colour"
                value={normalizeHex(brand.theme.background) ?? "#0b0c0e"}
                onChange={(e) => {
                  setTheme({ background: e.target.value, preset: "custom" });
                  const preferred = preferredMode({ ...brand.theme, background: e.target.value });
                  if (preferred) updateSettings({ theme: preferred });
                }}
              />
              <button type="button" className="btn" disabled={!brand.theme.background} onClick={() => setTheme({ background: "", preset: "custom" })}>
                Neutral
              </button>
            </div>
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="mode">Mode</label>
            <select id="mode" className="select" value={mode} onChange={(e) => updateSettings({ theme: e.target.value as typeof mode })}>
              <option value="system">Match system</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="font">Font</label>
            <select
              id="font"
              className="select"
              value={FONTS[brand.theme.font] ? brand.theme.font : "custom"}
              onChange={(e) => e.target.value !== "custom" && setTheme({ font: e.target.value })}
            >
              {Object.entries(FONTS).map(([id, f]) => (
                <option key={id} value={id}>
                  {f.label}
                </option>
              ))}
              {!FONTS[brand.theme.font] && <option value="custom">{brand.theme.font}</option>}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="radius">
            Corners <span className="muted small">{brand.theme.radius}px</span>
          </label>
          <input id="radius" type="range" min={0} max={20} step={1} value={brand.theme.radius} onChange={(e) => setTheme({ radius: Number(e.target.value) })} />
        </div>
      </Section>

      <Section
        title="Brand kit"
        hint="Share your look with colleagues, or rebrand the installable apps: run “npm run brand your-brand-kit.json”, then rebuild."
      >
        <div className="btn-row">
          <button type="button" className="btn" onClick={exportKit}>
            <Download size={14} /> Export brand kit
          </button>
          <button type="button" className="btn" onClick={() => kitInput.current?.click()}>
            <Upload size={14} /> Import brand kit
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              updateSettings({ brand: { ...defaultSettings.brand, theme: DEFAULT_THEME } });
              setSuggestion(null);
            }}
          >
            <RotateCcw size={14} /> Reset to default
          </button>
          <input
            ref={kitInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                const kit = JSON.parse(await file.text());
                if (kit.app !== "adt-bot-brand") throw new Error("That isn't a brand kit file.");
                updateSettings({
                  brand: {
                    name: String(kit.name || defaultSettings.brand.name),
                    logo: typeof kit.logo === "string" ? kit.logo : "",
                    logoAsAvatar: Boolean(kit.logoAsAvatar),
                    theme: { ...DEFAULT_THEME, ...kit.theme },
                  },
                });
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </div>
      </Section>
    </div>
  );
}

function matchFont(name: string): string {
  const n = name.toLowerCase();
  if (/mono|code|courier|consol/.test(n)) return "mono";
  if (/serif|georgia|garamond|times|playfair|merriweather|lora/.test(n) && !/sans/.test(n)) return "serif";
  if (/nunito|rounded|quicksand|varela/.test(n)) return "rounded";
  if (/futura|montserrat|poppins|century|gotham|avenir/.test(n)) return /avenir/.test(n) ? "humanist" : "geometric";
  if (/system|inter|roboto|helvetica|arial|segoe|sf pro|sans/.test(n)) return "system";
  return name;
}
