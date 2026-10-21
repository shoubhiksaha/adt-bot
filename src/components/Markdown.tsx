import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { linkCitations, prepareMath, splitBlocks } from "../lib/markdown-utils";
import type { Source } from "../lib/types";
import { parseRichBlock } from "../lib/visualize/fences";
import { CopyButton } from "./CopyButton";
import { RichBlockView } from "./viz/RichBlock";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  const className: string = (child as { props?: { className?: string } })?.props?.className ?? "";
  const language = /language-([\w+-]+)/.exec(className)?.[1] ?? "text";
  // ```chart / ```card blocks become inline charts and cards; malformed JSON stays a code block.
  const rich = parseRichBlock(language, textOf(children));
  if (rich) return <RichBlockView block={rich} />;
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language}</span>
        <CopyButton text={textOf(children).replace(/\n$/, "")} label="Copy" />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** Images the app made itself (attachments, generated images) load straight away. */
const LOCAL_IMAGE = /^(data:image\/|blob:|app:\/\/adtbot\/|\.\/|\/(?!\/))/i;

/**
 * A remote image in a reply loads only when the user asks: fetching it would send its URL (which
 * an injected page can fill with data from the conversation) to that server.
 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [load, setLoad] = useState(false);
  if (!src) return null;
  if (LOCAL_IMAGE.test(src) || load) return <img src={src} alt={alt ?? ""} loading="lazy" className="md-image" />;
  let host = "";
  try {
    host = new URL(src).host;
  } catch {
    return null;
  }
  if (!/^https:\/\//i.test(src)) return <span className="md-image-blocked">[image: {alt || host}]</span>;
  return (
    <button type="button" className="md-image-placeholder" onClick={() => setLoad(true)} title={src}>
      <span aria-hidden="true">🖼</span> {alt ? `${alt} · ` : ""}Load image from {host}
    </button>
  );
}

const remarkPlugins: Options["remarkPlugins"] = [remarkGfm];
// Only highlight labelled code: guessing the language runs every grammar and is slow.
const rehypePlugins: NonNullable<Options["rehypePlugins"]> = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

/** Math (KaTeX) loads the first time a reply has some. */
type MathPlugins = { remark: Options["remarkPlugins"]; rehype: NonNullable<Options["rehypePlugins"]> };
let mathPlugins: MathPlugins | null = null;
let mathLoading: Promise<void> | null = null;

function useMath(needed: boolean): MathPlugins | null {
  const [, setLoaded] = useState(false);
  useEffect(() => {
    if (!needed || mathPlugins) return;
    mathLoading ??= Promise.all([import("remark-math"), import("rehype-katex"), import("katex/dist/katex.min.css")]).then(([math, katex]) => {
      mathPlugins = { remark: [remarkGfm, math.default], rehype: [[katex.default, { throwOnError: false, strict: "ignore" }]] };
    });
    let live = true;
    void mathLoading.then(() => live && setLoaded(true)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [needed]);
  return needed ? mathPlugins : null;
}
const components = {
  pre: CodeBlock,
  img: MarkdownImage,
  a: ({ href, title, children }: { href?: string; title?: string; children?: ReactNode }) => {
    const citation = typeof children === "string" && /^\d{1,2}$/.test(children) ? children : null;
    return (
      <a href={href} title={title} target="_blank" rel="noreferrer noopener" className={citation ? "cite" : undefined}>
        {children}
      </a>
    );
  },
  table: ({ children }: { children?: ReactNode }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
};

const Block = memo(function Block({ text, highlight }: { text: string; highlight: boolean }) {
  const prepared = useMemo(() => prepareMath(text), [text]);
  const math = useMath(prepared.math);
  const rehype = [...(math?.rehype ?? []), ...(highlight ? rehypePlugins : [])];
  return (
    <ReactMarkdown remarkPlugins={math?.remark ?? remarkPlugins} rehypePlugins={rehype.length ? rehype : undefined} components={components}>
      {prepared.text}
    </ReactMarkdown>
  );
});

/**
 * Markdown with GFM, highlighting and citation links, rendered block by block. While a reply
 * streams, finished blocks are memoised and the growing last block skips syntax highlighting.
 */
export default function Markdown({ text, sources, live = false }: { text: string; sources?: Source[]; live?: boolean }) {
  const blocks = useMemo(() => splitBlocks(text).map((b) => linkCitations(b, sources)), [text, sources]);
  return (
    <div className="md">
      {blocks.map((block, i) => (
        // Index keys are right here: blocks only ever append or change at the end.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
        <Block key={i} text={block} highlight={!live || i < blocks.length - 1} />
      ))}
    </div>
  );
}
