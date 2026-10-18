// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { runVisualize } from "../../lib/visualize/tool";
import Markdown from "../Markdown";
import { ToolCalls } from "../ToolCalls";
import { RichCard } from "./RichCard";
import { Visualization } from "./Visualization";

const fence = (lang: string, body: string) => `Here you go:\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\nDone.`;

describe("Markdown rich blocks", () => {
  it("renders a ```chart block as a chart", () => {
    const html = renderToStaticMarkup(<Markdown text={fence("chart", '{"kind":"bar","title":"Revenue","bars":[{"label":"Q1","value":10},{"label":"Q2","value":"20"}]}')} />);
    expect(html).toContain('class="viz"');
    expect(html).toContain("Revenue");
    expect(html).toContain("viz-bar-fill");
    expect(html).toContain("width:50%");
    expect(html).not.toContain("code-block");
    expect(html).toContain("Done.");
  });

  it("falls back to a code block for malformed JSON", () => {
    const html = renderToStaticMarkup(<Markdown text={fence("chart", '{"kind":"bar", oops')} />);
    expect(html).toContain("code-block");
    expect(html).not.toContain('class="viz"');
  });

  it("renders an email ```card with Copy and Open in Mail", () => {
    const html = renderToStaticMarkup(<Markdown text={fence("card", '{"type":"email","to":["sam@acme.com"],"subject":"Lunch?","body":"Free at 1?"}')} />);
    expect(html).toContain("rich-card");
    expect(html).toContain("Lunch?");
    expect(html).toContain('href="mailto:sam%40acme.com?subject=Lunch%3F&amp;body=Free%20at%201%3F"');
    expect(html).toContain("Open in Mail");
    expect(html).toContain("Copy");
  });

  it("leaves ordinary code blocks alone", () => {
    const html = renderToStaticMarkup(<Markdown text={fence("json", '{"kind":"bar"}')} />);
    expect(html).toContain("code-block");
  });
});

describe("components", () => {
  it("draws every kind without crashing, including empty data", () => {
    for (const kind of ["flow", "bar", "stats", "timeline"]) {
      expect(renderToStaticMarkup(<Visualization spec={{ kind: kind as never, title: "Empty" }} />)).toContain("Empty");
    }
    const flow = renderToStaticMarkup(
      <Visualization
        spec={{
          kind: "flow",
          title: "Pipeline",
          nodes: [
            { id: "a", title: "Ingest" },
            { id: "b", title: "Index" },
            { id: "c", title: "Answer" },
          ],
          edges: [
            { from: "a", to: "b", label: "docs" },
            { from: "b", to: "c" },
            { from: "c", to: "a" },
            { from: "a", to: "missing" },
          ],
          legend: [{ label: "Live", tone: "positive" }],
          caption: "Simplified.",
        }}
      />,
    );
    expect(flow.match(/class="viz-node"/g)).toHaveLength(3);
    expect(flow).toContain("docs");
    expect(flow).toContain("Simplified.");
  });

  it("link cards show the real host", () => {
    const html = renderToStaticMarkup(<RichCard spec={{ type: "link", title: "Reset", url: "https://google.com@evil.example/reset" }} />);
    expect(html).toContain("evil.example");
    expect(html).toContain('target="_blank"');
  });

  it("ToolCalls shows a visualize result even when collapsed", async () => {
    const result = await runVisualize({ kind: "stats", title: "KPIs", metrics: [{ label: "MRR", value: "$12k" }] });
    const html = renderToStaticMarkup(
      <ToolCalls calls={[{ id: "1", name: "visualize", args: {}, status: "done", result: result.content, display: result.display }]} live={false} />,
    );
    expect(html).toContain("$12k");
    expect(html).not.toContain("tool-list");
  });
});
