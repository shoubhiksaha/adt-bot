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
    return source ? `[${n}](${source.url} "${source.title.replace(/"/g, "'")}")` : match;
  });
}
