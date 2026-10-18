import { providerFetch } from "./transport";
import type { Settings, Source } from "./types";

export const SEARCH_ENGINES: { id: Settings["search"]["engine"]; name: string; needs: "none" | "key" | "url"; help: string }[] = [
  {
    id: "duckduckgo",
    name: "Free (DuckDuckGo + Wikipedia)",
    needs: "none",
    help: "No key. Best effort: DuckDuckGo may rate-limit, then Wikipedia and instant answers are used.",
  },
  { id: "brave", name: "Brave Search", needs: "key", help: "Free tier at api-dashboard.search.brave.com." },
  { id: "tavily", name: "Tavily", needs: "key", help: "Built for AI answers. Free tier at app.tavily.com." },
  { id: "searxng", name: "SearXNG (self-hosted)", needs: "url", help: "Your own instance, with the JSON format enabled." },
];

const PAGE_CHARS = 3500;

/** Searches the web with the configured engine. Results include page text when `readPages` is on. */
export async function webSearch(
  query: string,
  search: Settings["search"],
  useProxy: boolean,
  signal?: AbortSignal,
): Promise<Source[]> {
  const timeout = AbortSignal.timeout(10000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let results: Source[];

  if (search.engine === "brave") {
    const res = await providerFetch(
      `https://api.search.brave.com/res/v1/web/search?count=8&q=${encodeURIComponent(query)}`,
      { method: "GET", headers: { accept: "application/json", "x-subscription-token": search.apiKey }, signal: combined },
      useProxy,
    );
    await ensureOk(res, "Brave Search");
    const json: any = await res.json();
    results = (json.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: stripTags(r.description ?? "") }));
  } else if (search.engine === "tavily") {
    const res = await providerFetch(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${search.apiKey}` },
        body: JSON.stringify({ query, max_results: 6, search_depth: "basic" }),
        signal: combined,
      },
      useProxy,
    );
    await ensureOk(res, "Tavily");
    const json: any = await res.json();
    results = (json.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? "", content: r.content }));
  } else if (search.engine === "searxng") {
    if (!search.url) throw new Error("Set your SearXNG address in Settings → Search.");
    const base = search.url.replace(/\/+$/, "");
    const res = await providerFetch(
      `${base}/search?format=json&q=${encodeURIComponent(query)}`,
      { method: "GET", headers: { accept: "application/json" }, signal: combined },
      useProxy,
    );
    await ensureOk(res, "SearXNG");
    const json: any = await res.json();
    results = (json.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
  } else {
    // GET: DuckDuckGo challenges form POSTs from non-browser clients.
    const res = await providerFetch(
      `https://html.duckduckgo.com/html/?kl=wt-wt&q=${encodeURIComponent(query)}`,
      { method: "GET", headers: { accept: "text/html" }, signal: combined },
      useProxy,
    );
    results = res.ok ? parseDuckDuckGo(await res.text()) : [];
    // DuckDuckGo rate-limits scrapers with a captcha; fall back to keyless APIs.
    if (!results.length) results = await freeFallback(query, useProxy, combined);
    if (!results.length) {
      throw new Error("The free search found nothing (DuckDuckGo may be rate-limiting). Add a free Brave or Tavily key in Settings → Search.");
    }
  }

  results = dedupe(results).slice(0, 6);
  if (search.readPages) {
    // Read the top pages for real substance, not just two-line snippets. Failures are fine.
    const pages = await Promise.allSettled(
      results.slice(0, 3).map((r) => (r.content ? Promise.resolve(r.content) : readPage(r.url, useProxy, signal))),
    );
    pages.forEach((page, i) => {
      if (page.status === "fulfilled" && page.value) results[i] = { ...results[i], content: page.value };
    });
  }
  return results;
}

/** Keyless sources that don't captcha: DuckDuckGo instant answers and Wikipedia. */
async function freeFallback(query: string, useProxy: boolean, signal: AbortSignal): Promise<Source[]> {
  const [instant, wiki] = await Promise.allSettled([
    providerFetch(
      `https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(query)}`,
      { method: "GET", headers: { accept: "application/json" }, signal },
      useProxy,
    ).then((r) => (r.ok ? r.json() : null)),
    providerFetch(
      `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=4&prop=extracts|info&exintro=1&explaintext=1&inprop=url&format=json&origin=*&gsrsearch=${encodeURIComponent(query)}`,
      { method: "GET", headers: { accept: "application/json" }, signal },
      useProxy,
    ).then((r) => (r.ok ? r.json() : null)),
  ]);
  const results: Source[] = [];
  const ia: any = instant.status === "fulfilled" ? instant.value : null;
  if (ia?.AbstractText && ia.AbstractURL) {
    results.push({ title: ia.Heading || ia.AbstractSource || "Summary", url: ia.AbstractURL, snippet: ia.AbstractText, content: ia.AbstractText });
  }
  const pages: any[] = Object.values((wiki.status === "fulfilled" ? wiki.value : null)?.query?.pages ?? {});
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const page of pages) {
    if (page.fullurl && page.extract) {
      results.push({ title: `${page.title} – Wikipedia`, url: page.fullurl, snippet: page.extract.slice(0, 300), content: page.extract.slice(0, PAGE_CHARS) });
    }
  }
  for (const topic of (ia?.RelatedTopics ?? []).slice(0, 4)) {
    if (topic.FirstURL && topic.Text) results.push({ title: topic.Text.split(" - ")[0], url: topic.FirstURL, snippet: topic.Text });
  }
  return results;
}

/** Fetches a web page and returns its readable text (or null when it can't be read). */
export async function readPage(url: string, useProxy: boolean, signal?: AbortSignal): Promise<string | null> {
  try {
    const timeout = AbortSignal.timeout(7000);
    const res = await providerFetch(
      url,
      { method: "GET", headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
      useProxy,
    );
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/text|json|xml/.test(type) && type) return null;
    const body = await res.text();
    const text = type.includes("html") || /^\s*</.test(body) ? extractText(body) : body.replace(/\s+/g, " ").trim();
    return text ? text.slice(0, PAGE_CHARS) : null;
  } catch {
    return null;
  }
}

/** Links pasted into a message, which the bot should read like a browser would. */
export function findUrls(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g) ?? [];
  return [...new Set(urls)].slice(0, 3);
}

export function parseDuckDuckGo(html: string): Source[] {
  const results: Source[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b/).slice(1);
  for (const block of blocks) {
    if (/result--ad|y\.js\?/.test(block.slice(0, 600))) continue;
    const link = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
      ?? /<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/.exec(block);
    const url = resolveDuckDuckGoUrl(decodeEntities(link[1]));
    if (!url) continue;
    results.push({ title: stripTags(link[2]), url, snippet: snippet ? stripTags(snippet[1]) : "" });
  }
  return results;
}

function resolveDuckDuckGoUrl(href: string): string | null {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    const resolved = target ?? url.toString();
    return /^https?:/.test(resolved) && !resolved.includes("duckduckgo.com/y.js") ? resolved : null;
  } catch {
    return null;
  }
}

/** Readable text from an HTML page: main content first, chrome and scripts removed. */
export function extractText(html: string): string {
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ");
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && stripTags(main[2]).length > 400) body = main[2];
  body = body.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  return stripTags(body.replace(/<\/(p|div|li|h[1-6]|tr|br|section)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n"))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/[ \t\r]+/g, " ").trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function dedupe(results: Source[]): Source[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (!r.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function ensureOk(res: Response, engine: string) {
  if (res.ok) return;
  const hint = res.status === 401 || res.status === 403 || res.status === 422 ? " Check its key in Settings → Search." : "";
  throw new Error(`${engine} search failed (${res.status}).${hint}`);
}

/** Context block that grounds the answer in the results and asks for [n] citations. */
export function sourcesPrompt(query: string, sources: Source[], pages: { url: string; text: string }[]): string {
  const parts: string[] = [];
  if (pages.length) {
    parts.push(
      "The user linked these pages. Their content:\n\n" +
        pages.map((p) => `<page url="${p.url}">\n${p.text}\n</page>`).join("\n\n"),
    );
  }
  if (sources.length) {
    const list = sources
      .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${(s.content ?? s.snippet).slice(0, PAGE_CHARS)}`)
      .join("\n\n");
    parts.push(
      `Fresh web search results for "${query}" (retrieved ${new Date().toUTCString()}):\n\n${list}\n\n` +
        "Answer using these results. Cite them inline as [1], [2] right after the facts they support. " +
        "If they don't cover the question, say so and answer from your own knowledge.",
    );
  }
  return parts.join("\n\n");
}
