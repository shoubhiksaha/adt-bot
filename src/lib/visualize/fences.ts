import { parseCard, type RichCardSpec } from "./cards";
import { parseVisualization, type VisualizationSpec } from "./normalise";

/**
 * Fenced blocks the Markdown renderer turns into components. The aliases are what models guess
 * unprompted (and what OpenBOT-trained prompts produce).
 */
export const CHART_LANGS = new Set(["chart", "visualization", "visualisation", "viz", "openbot-widget", "openbot-viz"]);
export const CARD_LANGS = new Set(["card", "openbot-card", "grokbot-card"]);

export type RichBlock = { kind: "visualization"; spec: VisualizationSpec } | { kind: "card"; spec: RichCardSpec };

/** The first word of a fence's info string (or a `language-x` class), lowercased. */
export function fenceLang(info: string | undefined | null): string {
  return (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/**
 * A chart or card for a fenced block, or null to render it as an ordinary code block (unknown
 * language, malformed JSON, unknown card type).
 */
export function parseRichBlock(lang: string, body: string): RichBlock | null {
  const tag = fenceLang(lang);
  if (CHART_LANGS.has(tag)) {
    const spec = parseVisualization(body);
    return spec ? { kind: "visualization", spec } : null;
  }
  if (CARD_LANGS.has(tag)) {
    const spec = parseCard(body);
    return spec ? { kind: "card", spec } : null;
  }
  return null;
}

/** Added to the system prompt (not in voice mode) so bots know they can draw these blocks. */
export const RICH_BLOCKS_GUIDANCE =
  "Optional rich output: a fenced ```chart block holding a JSON spec renders as an inline chart " +
  '({"kind":"bar","title":…,"bars":[{"label","value"}]}; also "stats" with metrics [{label,value}], ' +
  '"timeline" with events [{title,time?}], "flow" with nodes [{id,title}] and edges [{from,to}]). ' +
  'A fenced ```card block renders an actionable card: {"type":"email","to":[…],"subject","body"}, ' +
  '{"type":"message","service","body"} or {"type":"link","title","url","description?"}. ' +
  "Use them only when they make the answer clearer or more actionable.";
