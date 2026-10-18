// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors. See src/lib/agent/vendor/openbot/LICENSE.
import type { ReactNode } from "react";
import type { VisualizationBar, VisualizationEvent, VisualizationMetric, VisualizationSpec } from "../../lib/agent/vendor/openbot/visualization";
import { describeVisualization } from "../../lib/visualize/normalise";
import { VisualizationFlow } from "./VisualizationFlow";
import "./viz.css";

/**
 * An inline chart: header, the kind-specific body, legend/caption footer. Drawn with plain
 * HTML/SVG and CSS (no chart library), so it inherits the theme. Tones are `data-tone`
 * attributes resolved to theme colours in viz.css.
 */
export function Visualization({ spec }: { spec: VisualizationSpec }): ReactNode {
  return (
    <figure className="viz" role="group" aria-label={describeVisualization(spec)}>
      <header className="viz-head">
        <span className="viz-kind">{spec.kind}</span>
        <span className="viz-titles">
          <span className="viz-title">{spec.title}</span>
          {spec.subtitle ? <span className="viz-subtitle">{spec.subtitle}</span> : null}
        </span>
      </header>
      <div className="viz-body">
        {spec.kind === "flow" ? <VisualizationFlow spec={spec} /> : null}
        {spec.kind === "bar" ? <Bars bars={spec.bars ?? []} /> : null}
        {spec.kind === "stats" ? <Stats metrics={spec.metrics ?? []} /> : null}
        {spec.kind === "timeline" ? <Timeline events={spec.events ?? []} /> : null}
      </div>
      <Foot spec={spec} />
    </figure>
  );
}

function Foot({ spec }: { spec: VisualizationSpec }): ReactNode {
  const legend = spec.legend ?? [];
  if (legend.length === 0 && !spec.caption) return null;
  return (
    <figcaption className="viz-foot">
      {legend.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat
        <span className="viz-legend" key={`${item.label}-${i}`}>
          <span className="viz-swatch" data-tone={item.tone ?? "muted"} aria-hidden="true" />
          {item.label}
        </span>
      ))}
      {spec.caption ? <span className="viz-caption">{spec.caption}</span> : null}
    </figcaption>
  );
}

/** Fraction digits follow the magnitude; past a quadrillion the exponent is clearer. */
export function formatValue(value: number): string {
  if (Math.abs(value) >= 1e15) return value.toExponential(2);
  const digits = Math.abs(value) < 10 && !Number.isInteger(value) ? 2 : 0;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
}

/** Horizontal bars. A row with its own `max` uses that scale (so 60% stays 60%); others share the peak. */
function Bars({ bars }: { bars: VisualizationBar[] }): ReactNode {
  if (bars.length === 0) return <p className="viz-empty">No bars supplied.</p>;
  const peak = Math.max(1, ...bars.map((b) => Math.abs(b.max ?? b.value)));
  return (
    <ul className="viz-bars">
      {bars.map((bar, i) => {
        const scale = bar.max !== undefined && bar.max > 0 ? bar.max : peak;
        const ratio = (bar.value / scale) * 100;
        const width = Number.isFinite(ratio) ? Math.max(0, Math.min(100, ratio)) : 0;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat
          <li className="viz-bar" key={`${bar.label}-${i}`}>
            <div className="viz-bar-head">
              <span className="viz-bar-label" title={bar.label}>
                {bar.label}
              </span>
              {bar.detail ? <span className="viz-bar-detail">{bar.detail}</span> : null}
              <span className="viz-bar-value">{formatValue(bar.value)}</span>
            </div>
            <div className="viz-bar-track" role="meter" aria-label={bar.label} aria-valuenow={bar.value} aria-valuemin={0} aria-valuemax={scale}>
              <span className="viz-bar-fill" data-tone={bar.tone ?? "accent"} style={{ width: `${Math.max(width, 0.8)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Headline figures, rendered verbatim ("1.2M", "38%"), reflowing on narrow screens. */
function Stats({ metrics }: { metrics: VisualizationMetric[] }): ReactNode {
  if (metrics.length === 0) return <p className="viz-empty">No metrics supplied.</p>;
  return (
    <dl className="viz-stats">
      {metrics.map((metric, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat
        <div className="viz-stat" data-tone={metric.tone ?? "muted"} key={`${metric.label}-${i}`}>
          <dt className="viz-stat-label">
            <span className="viz-dot" aria-hidden="true" />
            {metric.label}
          </dt>
          <dd className="viz-stat-value">{metric.value}</dd>
          {metric.detail ? <dd className="viz-stat-detail">{metric.detail}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** Ordered events on one rail, drawn per row so rows of different heights stay joined. */
function Timeline({ events }: { events: VisualizationEvent[] }): ReactNode {
  if (events.length === 0) return <p className="viz-empty">No events supplied.</p>;
  return (
    <ol className="viz-timeline">
      {events.map((event, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: titles may repeat
        <li className="viz-event" data-tone={event.tone ?? "muted"} data-last={i === events.length - 1} key={`${event.title}-${i}`}>
          <span className="viz-event-rail" aria-hidden="true">
            <span className="viz-event-dot" />
          </span>
          <div className="viz-event-body">
            <div className="viz-event-head">
              <span className="viz-event-title">{event.title}</span>
              {event.time ? <span className="viz-event-time">{event.time}</span> : null}
            </div>
            {event.detail ? <p className="viz-event-detail">{event.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
