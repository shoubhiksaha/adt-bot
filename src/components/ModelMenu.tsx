import { Clock, Eye, Lightbulb } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { setBotModel, useStore } from "../lib/store";
import type { Bot, ModelInfo } from "../lib/types";

type Row = { providerId: string; providerName: string; model: ModelInfo; recent?: boolean };

/** Searchable model picker across every connected provider, with recents and arrow-key navigation. */
export function ModelMenu({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const providers = useStore((s) => s.providers);
  const recent = useStore((s) => s.settings.recentModels);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (m: ModelInfo) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q);
    const out: Row[] = [];
    if (!q) {
      for (const key of recent) {
        const [providerId, modelId] = key.split("::");
        const provider = providers.find((p) => p.id === providerId);
        if (!provider) continue;
        const model = provider.models.find((m) => m.id === modelId) ?? { id: modelId };
        out.push({ providerId, providerName: provider.name, model, recent: true });
      }
    }
    for (const p of providers) {
      for (const m of p.models.filter(match).slice(0, q ? 40 : 25)) out.push({ providerId: p.id, providerName: p.name, model: m });
    }
    return out;
  }, [providers, recent, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (providerId: string, model: string) => {
    setBotModel(bot.id, providerId, model);
    onClose();
  };

  let lastGroup = "";
  return (
    <div className="model-menu" ref={ref} role="dialog" aria-label="Choose model">
      <input
        className="input"
        autoFocus
        placeholder="Search models, or type any model id"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, rows.length - 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          }
          if (e.key === "Enter") {
            const row = rows[active];
            if (row) pick(row.providerId, row.model.id);
            else if (query.trim() && bot.providerId) pick(bot.providerId, query.trim());
          }
        }}
      />
      <div className="model-list" ref={listRef}>
        {query.trim() && bot.providerId && (
          <button type="button" className="nav-item" onClick={() => pick(bot.providerId, query.trim())}>
            <span className="label">Use “{query.trim()}” with the current provider</span>
          </button>
        )}
        {rows.length === 0 && <div className="small muted" style={{ padding: 8 }}>No matching models. Press Fetch in bot settings to refresh a provider's list.</div>}
        {rows.map((row, i) => {
          const group = row.recent ? "Recent" : row.providerName;
          const header = group !== lastGroup;
          lastGroup = group;
          const selected = bot.providerId === row.providerId && bot.model === row.model.id;
          return (
            <div key={`${group}-${row.providerId}-${row.model.id}`}>
              {header && <div className="section-label">{group}</div>}
              <button
                type="button"
                data-index={i}
                className={`nav-item${selected ? " active" : ""}${i === active ? " focus" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(row.providerId, row.model.id)}
              >
                {row.recent && <Clock size={13} className="muted" />}
                <span className="label">
                  {row.model.id}
                  {row.recent && <span className="muted small"> · {row.providerName}</span>}
                </span>
                {row.model.reasoning && <Lightbulb size={13} className="muted" aria-label="Reasoning" />}
                {row.model.vision && <Eye size={13} className="muted" aria-label="Sees images" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
