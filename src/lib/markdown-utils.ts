import type { Source } from "./types";

/**
 * Splits Markdown into top-level blocks at blank lines (never inside code fences or before
 * indented continuation lines). While a reply streams only the last block changes, so earlier
 * blocks can skip re-parsing and re-highlighting.
 */
export function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0].repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
    }
    const next = lines[i + 1];
    const splitHere = !fence && line.trim() === "" && current.length > 0 && next !== undefined && next.trim() !== "" && !/^[ \t]/.test(next);
    if (splitHere) {
      blocks.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

/** Turns [1], [2]… into links to the matching web sources (outside code). */
export function linkCitations(block: string, sources: Source[] | undefined): string {
  if (!sources?.length || /^\s{0,3}(```|~~~)/.test(block)) return block;
  return block.replace(/\[(\d{1,2})\](?![(:])/g, (match, n: string) => {
    const source = sources[Number(n) - 1];
    if (!source || typeof source.url !== "string") return match;
    // The address in <…> (spaces and parentheses can't end the link early); the title without quotes or brackets.
    const url = source.url.replace(/[<>\s]/g, encodeURIComponent);
    const title = String(source.title ?? "").replace(/["\\\n\r]/g, "'").slice(0, 200);
    return `[${n}](<${url}> "${title}")`;
  });
}

/**
 * A block's math, ready for remark-math: \( \) and \[ \] become $ and $$, and a $ before a digit is a
 * price ("$5 to $10"), not math. Code is left alone. `math`: whether any math is left to render.
 */
export function prepareMath(block: string): { text: string; math: boolean } {
  if (/^\s{0,3}(```|~~~)/m.test(block) || !/[$\\]/.test(block)) return { text: block, math: false };
  let math = false;
  // Inline code spans (odd parts) stay as they are.
  const text = block
    .split(/(`+[^`]*`+)/)
    .map((part, i) => {
      if (i % 2) return part;
      const out = part
        // On a line of its own, \[ … \] is display math (a block); inside a sentence it stays inline.
        .replace(/^([ \t]*)\\\[([\s\S]+?)\\\][ \t]*$/gm, (_, indent: string, m: string) => `${indent}$$\n${indent}${m.trim()}\n${indent}$$`)
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `$$${m}$$`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$${m.trim()}$`)
        .replace(/(?<![\\$])\$(?=\d)/g, "\\$");
      if (/(?<!\\)\$/.test(out)) math = true;
      return out;
    })
    .join("");
  return { text, math };
}
