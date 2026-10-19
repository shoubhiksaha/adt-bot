// @vitest-environment node
import { describe, expect, it } from "vitest";
import { allTools, getTool } from "../agent/tools";
import { cardText, linkHost, MAILTO_BODY_MAX, mailtoUrl, parseCard } from "./cards";
import { finite, gridIndex, rows, text, tone } from "./coerce";
import { fenceLang, parseRichBlock, RICH_BLOCKS_GUIDANCE } from "./fences";
import { describeVisualization, LIMITS, normaliseVisualization, parseVisualization } from "./normalise";
import { runVisualize } from "./tool";

describe("coercion", () => {
  it("parses numbers with units, commas and junk", () => {
    expect(finite(12)).toBe(12);
    expect(finite("1,200")).toBe(1200);
    expect(finite("38%")).toBe(38);
    expect(finite("18ms")).toBe(18);
    expect(finite("$4.50")).toBe(4.5);
    expect(finite("-3.5 kg")).toBe(-3.5);
    expect(finite(Number.NaN, 7)).toBe(7);
    expect(finite(Number.POSITIVE_INFINITY)).toBe(0);
    expect(finite("")).toBe(0);
    expect(finite(null)).toBe(0);
    expect(finite({})).toBe(0);
  });

  it("never throws on hostile text and clamps length", () => {
    expect(text({ toString: 1 }, "fallback", 10)).toBe("fallback");
    expect(text(Object.create(null), "x", 10)).toBe("x");
    expect(text("  a\n\n b  ", "", 10)).toBe("a b");
    expect(text("y".repeat(10_000_000), "", 5)).toBe("yyyyy");
    expect(text(42, "", 5)).toBe("42");
  });

  it("only accepts known tones, case-insensitively", () => {
    expect(tone("Positive")).toBe("positive");
    expect(tone("red")).toBeUndefined();
    expect(tone(undefined)).toBeUndefined();
  });

  it("bounds grid indexes and ignores non-numbers", () => {
    expect(gridIndex(3.7)).toBe(3);
    expect(gridIndex(-5)).toBe(0);
    expect(gridIndex(99)).toBe(8);
    expect(gridIndex([])).toBeUndefined();
    expect(gridIndex("")).toBeUndefined();
    expect(gridIndex("abc")).toBeUndefined();
  });

  it("reads arrays given as JSON strings and wraps primitives", () => {
    expect(rows('[{"label":"a"}]', 5)).toEqual([{ label: "a" }]);
    expect(rows("[not json", 5)).toEqual([]);
    expect(rows(["x", 2], 5)).toEqual([{ label: "x" }, { label: 2 }]);
    expect(rows({ a: 1 }, 5)).toEqual([]);
  });
});

describe("normaliseVisualization", () => {
  it("turns garbage into an empty flow instead of throwing", () => {
    for (const input of [null, undefined, 42, "str", [], { kind: { toString: 1 } }]) {
      const spec = normaliseVisualization(input);
      expect(spec.kind).toBe("flow");
      expect(spec.title).toBe("Visualization");
    }
  });

  it("coerces a sloppy bar chart", () => {
    const spec = normaliseVisualization({
      kind: "Bar",
      title: "  Latency\nby region ",
      bars: [{ name: "EU", value: "120ms", tone: "WARNING" }, { label: "US", count: 80 }, "Asia"],
    });
    expect(spec.kind).toBe("bar");
    expect(spec.title).toBe("Latency by region");
    expect(spec.bars).toEqual([
      { label: "EU", value: 120, max: undefined, detail: undefined, tone: "warning" },
      { label: "US", value: 80, max: undefined, detail: undefined, tone: undefined },
      { label: "Asia", value: 0, max: undefined, detail: undefined, tone: undefined },
    ]);
    expect(spec.metrics).toBeUndefined();
  });

  it("accepts a wrapped spec, `type` for kind, and guesses the kind from the data", () => {
    expect(normaliseVisualization({ spec: { kind: "stats", title: "T", metrics: [] } }).kind).toBe("stats");
    expect(normaliseVisualization({ type: "timeline", events: [] }).kind).toBe("timeline");
    expect(normaliseVisualization({ kind: "pie", bars: [{ label: "a", value: 1 }] }).kind).toBe("bar");
    expect(normaliseVisualization({ metrics: [{ label: "a", value: "1" }] }).kind).toBe("stats");
  });

  it("caps collections and de-duplicates node ids", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: "same", title: `n${i}` }));
    const spec = normaliseVisualization({ kind: "flow", nodes: many, edges: [{ from: "same", to: "same#2" }, { from: "", to: "x" }] });
    expect(spec.nodes).toHaveLength(LIMITS.nodes);
    expect(new Set(spec.nodes?.map((n) => n.id)).size).toBe(LIMITS.nodes);
    expect(spec.nodes?.[1].id).toBe("same#2");
    expect(spec.edges).toEqual([{ from: "same", to: "same#2", label: undefined }]);
  });

  it("keeps metric values as pre-formatted text", () => {
    const spec = normaliseVisualization({ kind: "stats", metrics: [{ label: "Users", value: "1.2M" }, { label: "Empty" }] });
    expect(spec.metrics?.map((m) => m.value)).toEqual(["1.2M", "0"]);
  });

  it("parseVisualization returns null for non-objects", () => {
    expect(parseVisualization("{nope")).toBeNull();
    expect(parseVisualization("[1,2]")).toBeNull();
    expect(parseVisualization("null")).toBeNull();
    expect(parseVisualization('{"kind":"bar","bars":[]}')?.kind).toBe("bar");
  });

  it("describes a spec in one line", () => {
    expect(describeVisualization(normaliseVisualization({ kind: "bar", title: "X", bars: [{ label: "a", value: 1 }] }))).toBe(
      'bar chart "X" with 1 bar',
    );
  });
});

describe("cards", () => {
  it("parses email drafts, accepting aliases and comma-separated recipients", () => {
    expect(parseCard('{"type":"email-draft","to":"a@x.com, b@x.com","subject":"Hi","body":"Hello"}')).toEqual({
      type: "email",
      to: ["a@x.com", "b@x.com"],
      cc: undefined,
      subject: "Hi",
      body: "Hello",
    });
  });

  it("bounds recipients", () => {
    const card = parseCard(JSON.stringify({ type: "email", to: Array.from({ length: 200 }, () => "z".repeat(1000)), body: 5 }));
    expect(card?.type).toBe("email");
    if (card?.type !== "email") return;
    expect(card.to).toHaveLength(50);
    expect(card.to[0]).toHaveLength(320);
    expect(card.body).toBe("5");
  });

  it("parses message drafts with defaults", () => {
    expect(parseCard('{"type":"message","body":"On my way"}')).toEqual({ type: "message", service: "Message", channel: undefined, to: undefined, body: "On my way" });
  });

  it("only accepts http(s) links", () => {
    expect(parseCard('{"type":"link","url":"javascript:alert(1)","title":"x"}')).toBeNull();
    expect(parseCard('{"type":"link","url":"not a url"}')).toBeNull();
    expect(parseCard('{"type":"link","url":"https://example.com/a b"}')).toEqual({
      type: "link",
      title: "https://example.com/a%20b",
      description: undefined,
      url: "https://example.com/a%20b",
    });
    expect(linkHost("https://google.com@evil.example/reset")).toBe("evil.example");
  });

  it("rejects unknown types and malformed JSON", () => {
    expect(parseCard('{"type":"invoice"}')).toBeNull();
    expect(parseCard("{oops")).toBeNull();
    expect(parseCard("[]")).toBeNull();
  });

  it("builds an RFC 6068 mailto URL (no + for spaces) and truncates long bodies", () => {
    const url = mailtoUrl({ type: "email", to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], subject: "Hi there", body: "Line 1\nLine & 2" });
    expect(url).toBe("mailto:a%40x.com,b%40x.com?subject=Hi%20there&body=Line%201%0ALine%20%26%202&cc=c%40x.com");
    const long = mailtoUrl({ type: "email", to: [], subject: "", body: "x".repeat(10_000) });
    expect(long).toBe(`mailto:?body=${"x".repeat(MAILTO_BODY_MAX)}`);
  });

  it("copies a card as plain text", () => {
    expect(cardText({ type: "email", to: ["a@x.com"], subject: "S", body: "B" })).toBe("To: a@x.com\nSubject: S\n\nB");
    expect(cardText({ type: "message", service: "Slack", body: "yo" })).toBe("yo");
  });
});

describe("fenced blocks", () => {
  it("reads the first word of the info string", () => {
    expect(fenceLang(" Chart json ")).toBe("chart");
    expect(fenceLang(undefined)).toBe("");
  });

  it("turns chart and card fences into blocks", () => {
    expect(parseRichBlock("chart", '{"kind":"stats","title":"KPIs","metrics":[{"label":"MRR","value":"$12k"}]}')).toMatchObject({
      kind: "visualization",
      spec: { kind: "stats", title: "KPIs" },
    });
    expect(parseRichBlock("openbot-widget", '{"kind":"bar","bars":[]}')?.kind).toBe("visualization");
    expect(parseRichBlock("card", '{"type":"link","url":"https://adt.example","title":"ADT"}')).toMatchObject({ kind: "card", spec: { type: "link" } });
  });

  it("falls back (null) for malformed JSON, unknown cards and other languages", () => {
    expect(parseRichBlock("chart", '{"kind":"bar",')).toBeNull();
    expect(parseRichBlock("card", '{"type":"nope"}')).toBeNull();
    expect(parseRichBlock("json", '{"kind":"bar"}')).toBeNull();
    expect(parseRichBlock("", "{}")).toBeNull();
  });

  it("the prompt line mentions both fences", () => {
    expect(RICH_BLOCKS_GUIDANCE).toContain("```chart");
    expect(RICH_BLOCKS_GUIDANCE).toContain("```card");
  });
});

describe("visualize tool", () => {
  it("is registered in the create group as a read tool", () => {
    const tool = getTool("visualize");
    expect(tool).toBeDefined();
    expect(tool?.group).toBe("create");
    expect(tool?.risk).toBe("read");
    expect(tool?.parameters.required).toEqual(["kind", "title"]);
    expect(allTools().filter((t) => t.name === "visualize")).toHaveLength(1);
  });

  it("returns a short sentence for the model and the spec for the chat", async () => {
    const result = await runVisualize({ kind: "bar", title: "Sales", bars: [{ label: "Q1", value: 3 }] });
    expect(result.content).toBe('Drew a bar chart "Sales" with 1 bar. The user can see it; do not restate its contents.');
    expect(result.display).toMatchObject({ kind: "visualization", spec: { kind: "bar", bars: [{ label: "Q1", value: 3 }] } });
  });

  it("tells the model which array it forgot", async () => {
    const result = await runVisualize({ kind: "timeline", title: "Launch" });
    expect(result.content).toContain('Send the "events" array');
  });

  it("runs through the registered tool too", async () => {
    const result = await getTool("visualize")!.run({ kind: "stats", metrics: '[{"label":"A","value":"1"}]' }, {} as never);
    expect(typeof result === "object" && result.display?.kind).toBe("visualization");
  });
});

describe("fence aliases small models use", () => {
  it("draws ```bar and ```json chart specs, but leaves other JSON alone", async () => {
    const { parseRichBlock } = await import("./fences");
    const bars = '{"title":"Sales","bars":[{"label":"Jan","value":10},{"label":"Feb","value":20}]}';
    expect(parseRichBlock("bar", bars)?.kind).toBe("visualization");
    expect(parseRichBlock("json", bars)).toBeNull();
    expect(parseRichBlock("json", `{"kind":"bar",${bars.slice(1)}`)?.kind).toBe("visualization");
    expect(parseRichBlock("json", '{"name":"Bob"}')).toBeNull();
    expect(parseRichBlock("bar", "not json")).toBeNull();
    expect(parseRichBlock("text", `{"kind":"bar",${bars.slice(1)}`)?.kind).toBe("visualization");
    expect(parseRichBlock("", '{"kind":"bar"}')).toBeNull();
  });
});
