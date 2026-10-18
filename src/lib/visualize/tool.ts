// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors. See ../agent/vendor/openbot/LICENSE.
/**
 * `visualize`: draw an inline chart in the chat. The whole tool is a normalisation pass
 * (arguments in, spec out, carried on the result's display). Nothing is read, written or run, so
 * it is "read" risk and never reaches the approval gate.
 */
import { registerTool, registerToolGroup, type ToolResult } from "../agent/tools";
import { dataKey, describeVisualization, isEmptyVisualization, normaliseVisualization } from "./normalise";
import { VISUALIZE_DESCRIPTION, VISUALIZE_TOOL_NAME, visualizeParameters } from "./schema";

/**
 * The model's view of what happened: a plain sentence rather than an echo of the spec, which
 * would burn context describing a picture the model just described.
 */
export async function runVisualize(args: Record<string, unknown>): Promise<Exclude<ToolResult, string>> {
  const spec = normaliseVisualization(args);
  const content = isEmptyVisualization(spec)
    ? `Drew an empty ${describeVisualization(spec)}. Send the "${dataKey(spec.kind)}" array to fill it in.`
    : `Drew a ${describeVisualization(spec)}. The user can see it; do not restate its contents.`;
  return { content, display: { kind: "visualization", spec } };
}

// The "create" group starts out as images only (builtin.ts); now it also draws charts.
registerToolGroup({ id: "create", label: "Create", description: "Create images with your image model and draw inline charts." });

registerTool({
  name: VISUALIZE_TOOL_NAME,
  group: "create",
  risk: "read",
  description: VISUALIZE_DESCRIPTION,
  parameters: visualizeParameters,
  timeoutMs: 5_000,
  run: (args) => runVisualize(args),
});
