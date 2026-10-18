// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors. See ../agent/vendor/openbot/LICENSE.
/**
 * The model-facing schema for `visualize`. The prose here is the real interface: a model picks a
 * `kind` from these descriptions, not from the type definitions.
 */

import { VISUALIZATION_KINDS, VISUALIZATION_TONES } from "../agent/vendor/openbot/visualization";
import type { JsonSchema } from "../agent/vendor/openbot/types";
import { MAX_GRID } from "./coerce";
import { LIMITS } from "./normalise";

export const VISUALIZE_TOOL_NAME = "visualize";

const tone = { type: "string", enum: [...VISUALIZATION_TONES], description: "Emphasis, not colour. The app themes it." } as const;

/** `toned: false` for elements drawn in one colour (edges): don't advertise a field that's dropped. */
const array = (description: string, properties: Record<string, unknown>, required: string[], toned = true): Record<string, unknown> => ({
  type: "array",
  description,
  items: { type: "object", properties: toned ? { ...properties, tone } : properties, required },
});

export const VISUALIZE_DESCRIPTION =
  "Draw an inline chart in the conversation. Use it when structure or magnitude is the point and a " +
  'list of numbers would not land: "flow" for a pipeline or architecture, "bar" for comparing ' +
  'quantities, "stats" for a row of headline figures, "timeline" for ordered events. Supply only the ' +
  "array that matches the kind. Keep labels short; they render inside boxes. Prefer prose for " +
  "anything that reads fine as a sentence; a chart per answer is too many.";

export const visualizeParameters: JsonSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...VISUALIZATION_KINDS], description: "Which chart to draw. Determines which data array is read." },
    title: { type: "string", description: "Short heading above the chart." },
    subtitle: { type: "string", description: "Optional one-line context under the title." },
    caption: { type: "string", description: "Optional sentence under the chart, beside the legend." },
    nodes: array(
      `kind="flow": the boxes, at most ${LIMITS.nodes}. Give each a stable id that edges refer to.`,
      {
        id: { type: "string", description: "Unique id used by edges." },
        title: { type: "string", description: "Box label, a few words." },
        subtitle: { type: "string", description: "Optional second line." },
        column: { type: "integer", description: `Optional 0-based column, 0-${MAX_GRID}; omit to lay out from the edges.` },
        row: { type: "integer", description: `Optional 0-based row within the column, 0-${MAX_GRID}.` },
      },
      ["id", "title"],
    ),
    edges: array(
      `kind="flow": directed connections, at most ${LIMITS.edges}. Both ends must name a node id.`,
      {
        from: { type: "string", description: "Source node id." },
        to: { type: "string", description: "Target node id." },
        label: { type: "string", description: "Optional label on the arrow." },
      },
      ["from", "to"],
      false,
    ),
    bars: array(
      `kind="bar": the rows, at most ${LIMITS.bars}. Bars scale to the largest value unless you set max.`,
      {
        label: { type: "string", description: "Row label." },
        value: { type: "number", description: "The quantity." },
        max: { type: "number", description: "Optional full-width value for this row, e.g. 100 for a percentage." },
        detail: { type: "string", description: "Optional note shown beside the value." },
      },
      ["label", "value"],
    ),
    metrics: array(
      `kind="stats": the tiles, at most ${LIMITS.metrics}. Format the value yourself, e.g. "1.2M" or "38%".`,
      {
        label: { type: "string", description: "What the figure measures." },
        value: { type: "string", description: "The figure, already formatted." },
        detail: { type: "string", description: "Optional comparison or trend." },
      },
      ["label", "value"],
    ),
    events: array(
      `kind="timeline": the entries in order, at most ${LIMITS.events}.`,
      {
        title: { type: "string", description: "What happened." },
        time: { type: "string", description: "Optional date, duration or step number." },
        detail: { type: "string", description: "Optional one-line elaboration." },
      },
      ["title"],
    ),
    legend: array(`Optional tone key shown under any chart, at most ${LIMITS.legend}.`, { label: { type: "string", description: "What this tone means." } }, [
      "label",
    ]),
  },
  required: ["kind", "title"],
};
