import type { RichBlock } from "../../lib/visualize/fences";
import { RichCard } from "./RichCard";
import { Visualization } from "./Visualization";

/** A parsed ```chart or ```card block. */
export function RichBlockView({ block }: { block: RichBlock }) {
  return block.kind === "visualization" ? <Visualization spec={block.spec} /> : <RichCard spec={block.spec} />;
}
