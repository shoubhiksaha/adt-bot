import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { linkCitations, splitBlocks } from "../lib/markdown-utils";
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

const remarkPlugins = [remarkGfm];
// Only highlight labelled code: guessing the language runs every grammar and is slow.
const rehypePlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as never;
const components = {
  pre: CodeBlock,
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
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={highlight ? rehypePlugins : undefined} components={components}>
      {text}
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
