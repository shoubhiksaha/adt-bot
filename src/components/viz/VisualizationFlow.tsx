// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors. See src/lib/agent/vendor/openbot/LICENSE.
import { type ReactNode, useId } from "react";
import type { VisualizationEdge, VisualizationNode, VisualizationSpec } from "../../lib/agent/vendor/openbot/visualization";

/** Node box and grid gutters, in CSS pixels. Fixed so the SVG and the boxes agree. */
const NODE_W = 176;
const NODE_H = 68;
const GAP_X = 64;
const GAP_Y = 36;
const PAD_X = 16;
/** Also the room a returning edge has to dip below the bottom row (see DIP). */
const PAD_Y = 24;
/** Gap between an arrow tip and the box it points at. */
const TIP = 6;
/** How far a returning edge dips below the boxes. TIP + DIP <= PAD_Y, so it stays on canvas. */
const DIP = 16;

type Placed = { x: number; y: number; node: VisualizationNode };

/**
 * Order nodes so every edge points forward where possible (Kahn's algorithm, spec order as the
 * tie-break). Nodes trapped in a cycle are appended afterwards so a cycle can't walk the diagram
 * off to the right.
 */
function topological(nodes: VisualizationNode[], successors: Map<string, string[]>): string[] {
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const [, targets] of successors) for (const to of targets) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const queued = new Set(queue);
  const order: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    order.push(id);
    for (const to of successors.get(id) ?? []) {
      const left = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, left);
      if (left <= 0 && !queued.has(to)) {
        queued.add(to);
        queue.push(to);
      }
    }
  }
  for (const n of nodes) if (!queued.has(n.id)) order.push(n.id);
  return order;
}

/**
 * Columns come from edge depth (a node sits one column right of everything pointing at it); an
 * explicit `column` pins a node. Both axes are renumbered densely before becoming pixels.
 */
export function layoutFlow(nodes: VisualizationNode[], edges: VisualizationEdge[]) {
  const known = new Set(nodes.map((n) => n.id));
  const successors = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (edge.from === edge.to || !known.has(edge.from) || !known.has(edge.to)) continue;
    successors.get(edge.from)?.push(edge.to);
  }

  const order = topological(nodes, successors);
  const rank = new Map(order.map((id, i) => [id, i]));
  const column = new Map(nodes.map((n) => [n.id, n.column ?? 0]));
  const pinned = new Set(nodes.filter((n) => n.column !== undefined).map((n) => n.id));
  for (const id of order) {
    const here = column.get(id) ?? 0;
    for (const to of successors.get(id) ?? []) {
      // Back-edges are drawn but never push: they are what a cycle is made of.
      if (pinned.has(to) || (rank.get(to) ?? 0) <= (rank.get(id) ?? 0)) continue;
      if ((column.get(to) ?? 0) < here + 1) column.set(to, here + 1);
    }
  }

  const columns = new Map<number, VisualizationNode[]>();
  for (const n of nodes) {
    const c = column.get(n.id) ?? 0;
    columns.set(c, [...(columns.get(c) ?? []), n]);
  }

  const cell = new Map<string, { c: number; r: number }>();
  for (const [c, list] of columns) {
    // Pinned rows claim their slot first; everyone else fills the gaps.
    const taken = new Set<number>();
    for (const node of list) {
      if (node.row === undefined) continue;
      let r = node.row;
      while (taken.has(r)) r++;
      taken.add(r);
      cell.set(node.id, { c, r });
    }
    let next = 0;
    for (const node of list) {
      if (cell.has(node.id)) continue;
      while (taken.has(next)) next++;
      taken.add(next);
      cell.set(node.id, { c, r: next });
    }
  }

  const axis = (values: number[]) => new Map([...new Set(values)].sort((a, b) => a - b).map((v, i) => [v, i]));
  const cols = axis([...cell.values()].map((p) => p.c));
  const rowsAxis = axis([...cell.values()].map((p) => p.r));
  const placed: Placed[] = nodes.map((node) => {
    const at = cell.get(node.id) ?? { c: 0, r: 0 };
    return { x: PAD_X + (cols.get(at.c) ?? 0) * (NODE_W + GAP_X), y: PAD_Y + (rowsAxis.get(at.r) ?? 0) * (NODE_H + GAP_Y), node };
  });
  const across = Math.max(1, cols.size);
  const down = Math.max(1, rowsAxis.size);
  return {
    placed,
    byId: new Map(placed.map((p) => [p.node.id, p])),
    width: PAD_X * 2 + across * NODE_W + (across - 1) * GAP_X,
    height: PAD_Y * 2 + down * NODE_H + (down - 1) * GAP_Y,
  };
}

/** Forward edges leave the right side and arrive at the left; anything else returns underneath. */
function edgePath(a: Placed, b: Placed): { d: string; midX: number; midY: number } {
  const rightOfA = a.x + NODE_W;
  if (b.x > rightOfA) {
    const startY = a.y + NODE_H / 2;
    const endY = b.y + NODE_H / 2;
    const bend = Math.max(24, (b.x - rightOfA) * 0.45);
    return {
      d: `M ${rightOfA} ${startY} C ${rightOfA + bend} ${startY}, ${b.x - bend} ${endY}, ${b.x - TIP} ${endY}`,
      midX: (rightOfA + b.x) / 2,
      midY: (startY + endY) / 2,
    };
  }
  const ax = a.x + NODE_W / 2;
  const bx = b.x + NODE_W / 2;
  if (Math.abs(bx - ax) < 1 && b.y > a.y) {
    return { d: `M ${ax} ${a.y + NODE_H} L ${bx} ${b.y - TIP}`, midX: ax, midY: (a.y + NODE_H + b.y) / 2 };
  }
  const ay = a.y + NODE_H;
  const by = b.y + NODE_H + TIP;
  return { d: `M ${ax} ${ay} C ${ax} ${ay + DIP}, ${bx} ${by + DIP}, ${bx} ${by}`, midX: (ax + bx) / 2, midY: Math.max(ay, by) + DIP * 0.7 };
}

/** Boxes over one SVG arrow layer. Wide diagrams scroll inside the card, never widening the chat. */
export function VisualizationFlow({ spec }: { spec: VisualizationSpec }): ReactNode {
  const marker = `viz-arrow-${useId().replace(/\W/g, "")}`;
  const nodes = spec.nodes?.length ? spec.nodes : [{ id: "root", title: spec.title, subtitle: spec.subtitle }];
  const edges = spec.edges ?? [];
  const { placed, byId, width, height } = layoutFlow(nodes, edges);

  return (
    <div className="viz-scroll">
      <div className="viz-flow" style={{ width, height }}>
        <svg className="viz-wires" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <defs>
            <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {edges.map((edge, i) => {
            const a = byId.get(edge.from);
            const b = byId.get(edge.to);
            if (!a || !b) return null;
            const { d, midX, midY } = edgePath(a, b);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: edges may repeat
              <g key={`${edge.from}-${edge.to}-${i}`}>
                <path d={d} markerEnd={`url(#${marker})`} />
                {edge.label ? (
                  <text x={midX} y={midY - 7} textAnchor="middle">
                    {edge.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {placed.map(({ x, y, node }) => (
          <div key={node.id} className="viz-node" data-tone={node.tone ?? "muted"} style={{ left: x, top: y, width: NODE_W, height: NODE_H }}>
            <span className="viz-node-title" title={node.title}>
              {node.title}
            </span>
            {node.subtitle ? <span className="viz-node-subtitle">{node.subtitle}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
