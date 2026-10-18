// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors. See ../agent/vendor/openbot/LICENSE.
/**
 * Turning model output into a drawable `VisualizationSpec`.
 *
 * Both routes into a chart (the `visualize` tool and the fenced ```chart block) land here, and
 * both carry unvalidated model output, so the rule is: never throw, always return something
 * renderable. A missing label becomes "Node 3"; `"12"` becomes 12; a 900-entry array becomes the
 * first 12; an unknown `kind` becomes `flow`. Hard caps keep one runaway generation from locking
 * up the renderer.
 */

import type {
  VisualizationBar,
  VisualizationEdge,
  VisualizationEvent,
  VisualizationKind,
  VisualizationLegendItem,
  VisualizationMetric,
  VisualizationNode,
  VisualizationSpec,
} from "../agent/vendor/openbot/visualization";
import { finite, gridIndex, KINDS, type Loose, optionalText, present, rows, text, tone } from "./coerce";

export type { VisualizationSpec };

/** How much of each collection survives normalisation. */
export const LIMITS = {
  nodes: 18,
  edges: 28,
  bars: 12,
  metrics: 8,
  events: 12,
  legend: 6,
} as const;

function toNodes(value: unknown): VisualizationNode[] {
  // Ids are the join key for edges and the React key, so a repeated id has to be broken here.
  const used = new Set<string>();
  return rows(value, LIMITS.nodes).map((n, i) => {
    const base = text(n.id, `node-${i + 1}`, 48);
    let id = base;
    for (let attempt = 2; used.has(id); attempt++) id = `${base}#${attempt}`;
    used.add(id);
    return {
      id,
      title: text(n.title ?? n.label ?? n.name, `Node ${i + 1}`, 80),
      subtitle: optionalText(n.subtitle ?? n.detail ?? n.description, 100),
      tone: tone(n.tone),
      column: gridIndex(n.column ?? n.col),
      row: gridIndex(n.row),
    };
  });
}

/** Edges naming a node that does not exist are dropped by the renderer, not here. */
function toEdges(value: unknown): VisualizationEdge[] {
  return rows(value, LIMITS.edges)
    .map((e) => ({
      from: text(e.from ?? e.source, "", 48),
      to: text(e.to ?? e.target, "", 48),
      label: optionalText(e.label, 60),
    }))
    .filter((e) => e.from !== "" && e.to !== "");
}

function toBars(value: unknown): VisualizationBar[] {
  return rows(value, LIMITS.bars).map((b, i) => ({
    label: text(b.label ?? b.name, `Item ${i + 1}`, 80),
    value: finite(b.value ?? b.count),
    max: b.max === null || b.max === undefined ? undefined : Math.max(0, finite(b.max)),
    detail: optionalText(b.detail, 90),
    tone: tone(b.tone),
  }));
}

function toMetrics(value: unknown): VisualizationMetric[] {
  return rows(value, LIMITS.metrics).map((m, i) => ({
    label: text(m.label ?? m.name, `Metric ${i + 1}`, 70),
    // Pre-formatted text, so "1.2M" survives; only a truly absent value falls back.
    value: text(m.value, "0", 70),
    detail: optionalText(m.detail, 100),
    tone: tone(m.tone),
  }));
}

function toEvents(value: unknown): VisualizationEvent[] {
  return rows(value, LIMITS.events).map((e, i) => ({
    title: text(e.title ?? e.label ?? e.name, `Event ${i + 1}`, 90),
    time: optionalText(e.time ?? e.date, 60),
    detail: optionalText(e.detail ?? e.description, 140),
    tone: tone(e.tone),
  }));
}

function toLegend(value: unknown): VisualizationLegendItem[] {
  return rows(value, LIMITS.legend)
    .map((l) => ({ label: text(l.label ?? l.name, "", 70), tone: tone(l.tone) }))
    .filter((l) => l.label !== "");
}

/**
 * Coerce anything into a spec. Total by design: callers get a chart or, at worst, an empty
 * `flow` titled "Visualization". Accepts the payload flat (`{ kind, bars }`) or wrapped
 * (`{ spec: … }`), and `type` as an alias of `kind`.
 */
export function normaliseVisualization(input: unknown): VisualizationSpec {
  const outer: Loose = input && typeof input === "object" ? (input as Loose) : {};
  const inner = outer.spec;
  const src: Loose = inner && typeof inner === "object" ? (inner as Loose) : outer;

  const named = text(src.kind ?? src.type, "", 20).toLowerCase();
  const kind: VisualizationKind = KINDS.has(named) ? (named as VisualizationKind) : guessKind(src);

  const spec: VisualizationSpec = {
    kind,
    title: text(src.title, kind === "bar" ? "Chart" : "Visualization", 120),
    subtitle: optionalText(src.subtitle, 180),
    caption: optionalText(src.caption, 240),
  };

  // Only attach collections the caller actually sent, so `spec.bars` staying undefined remains
  // a meaningful signal to the renderer.
  if (present(src.nodes)) spec.nodes = toNodes(src.nodes);
  if (present(src.edges)) spec.edges = toEdges(src.edges);
  if (present(src.bars)) spec.bars = toBars(src.bars);
  if (present(src.metrics)) spec.metrics = toMetrics(src.metrics);
  if (present(src.events)) spec.events = toEvents(src.events);
  if (present(src.legend)) spec.legend = toLegend(src.legend);

  return spec;
}

/** No (known) kind given: pick the one whose data array was supplied. */
function guessKind(src: Loose): VisualizationKind {
  if (present(src.bars)) return "bar";
  if (present(src.metrics)) return "stats";
  if (present(src.events)) return "timeline";
  return "flow";
}

/**
 * Parse the body of a fenced visualisation block. Returns `null` (not an empty chart) when the
 * text is not a JSON object, so the caller can fall back to the original code block.
 */
export function parseVisualization(json: string): VisualizationSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return normaliseVisualization(parsed);
}

/** One-line description of a spec, for tool output and accessibility labels. */
export function describeVisualization(spec: VisualizationSpec): string {
  const counts: string[] = [];
  const add = (n: number | undefined, word: string) => {
    if (n) counts.push(`${n} ${word}${n === 1 ? "" : "s"}`);
  };
  add(spec.nodes?.length, "node");
  add(spec.edges?.length, "edge");
  add(spec.bars?.length, "bar");
  add(spec.metrics?.length, "metric");
  add(spec.events?.length, "event");
  const body = counts.length > 0 ? ` with ${counts.join(", ")}` : " (no data supplied)";
  return `${spec.kind} chart "${spec.title}"${body}`;
}

/** True when the array the kind reads is missing or empty. */
export function isEmptyVisualization(spec: VisualizationSpec): boolean {
  return !spec[dataKey(spec.kind)]?.length;
}

/** Which data array a kind reads, named the way the schema names it. */
export function dataKey(kind: VisualizationKind): "nodes" | "bars" | "metrics" | "events" {
  return kind === "bar" ? "bars" : kind === "stats" ? "metrics" : kind === "timeline" ? "events" : "nodes";
}
