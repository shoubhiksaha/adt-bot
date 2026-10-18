// Vendored from OpenBOT (github.com/ashhart/OpenBot), MIT License, Copyright (c) 2026 OpenBOT contributors. See ./LICENSE.
/**
 * Inline visualisations.
 *
 * A `VisualizationSpec` is the whole contract between a model and the chart the
 * renderer draws. It is deliberately small and declarative: four shapes, a tone
 * vocabulary, and no styling — the renderer owns every colour and dimension so a
 * spec written months ago still matches the current theme.
 *
 * Two routes produce a spec, and both end at the same normaliser:
 *   1. the `visualize` tool, for backends that can call tools;
 *   2. a fenced ```openbot-widget block, for CLI backends that only emit text.
 *
 * Every field is optional in practice — the normaliser fills gaps rather than
 * rejecting input — so treat these types as "what a good spec looks like", not
 * as a guarantee about what arrives.
 */

export const VISUALIZATION_KINDS = ['flow', 'bar', 'stats', 'timeline'] as const
export type VisualizationKind = (typeof VISUALIZATION_KINDS)[number]

/**
 * Semantic emphasis, not colour. The renderer maps each tone onto an `--ob-*`
 * token so a spec never names a hex value.
 */
export const VISUALIZATION_TONES = ['accent', 'muted', 'positive', 'warning', 'danger'] as const
export type VisualizationTone = (typeof VISUALIZATION_TONES)[number]

/** A box in a `flow` diagram. `column`/`row` override the automatic layout. */
export interface VisualizationNode {
  id: string
  title: string
  subtitle?: string
  tone?: VisualizationTone
  /** 0-based grid column; omit to let edge depth decide. */
  column?: number
  /** 0-based grid row within the column; omit to stack in spec order. */
  row?: number
}

/** A directed connection between two `flow` nodes, matched on `VisualizationNode.id`. */
export interface VisualizationEdge {
  from: string
  to: string
  label?: string
}

/** One row of a `bar` chart. `max` sets a per-row scale; otherwise the chart's own peak is used. */
export interface VisualizationBar {
  label: string
  value: number
  max?: number
  detail?: string
  tone?: VisualizationTone
}

/** One tile of a `stats` grid. `value` is pre-formatted text, so "1.2M" and "38%" both work. */
export interface VisualizationMetric {
  label: string
  value: string
  detail?: string
  tone?: VisualizationTone
}

/** One entry on a `timeline`. `time` is free text — a date, a duration, a step number. */
export interface VisualizationEvent {
  title: string
  time?: string
  detail?: string
  tone?: VisualizationTone
}

/** A tone key shown under the chart. Applies to every kind. */
export interface VisualizationLegendItem {
  label: string
  tone?: VisualizationTone
}

/**
 * The normalised spec. `kind` selects which of the four payload arrays the
 * renderer reads; the others are ignored rather than an error, so a model that
 * over-supplies data still gets a chart.
 */
export interface VisualizationSpec {
  kind: VisualizationKind
  title: string
  subtitle?: string
  /** A sentence under the chart, next to the legend. */
  caption?: string
  nodes?: VisualizationNode[]
  edges?: VisualizationEdge[]
  bars?: VisualizationBar[]
  metrics?: VisualizationMetric[]
  events?: VisualizationEvent[]
  legend?: VisualizationLegendItem[]
}

/** Shape of `ToolResult.detail` for the `visualize` tool. */
export interface VisualizationDetail {
  visualization: VisualizationSpec
}
