import { complete } from "./llm";
import { contrast, luminance, normalizeHex, parseColor, rgbToHsl, toHex } from "./theme";
import { providerFetch } from "./transport";
import { useStore } from "./store";

/** What we could learn about a brand from a file or website. */
export type BrandSuggestion = {
  name?: string;
  logo?: string;
  accent?: string;
  background?: string;
  font?: string;
  /** Distinct colours found, most prominent first. */
  palette: string[];
  /** Readable text for the "ask AI" fallback (brand guides, PDFs). */
  text?: string;
  source: string;
};

const IMAGE = /^image\//;

/** Learn a brand from any file: a logo, brand-guide PDF, Word doc, CSS/SCSS/tokens JSON, HTML page… */
export async function brandFromFile(file: File): Promise<BrandSuggestion> {
  if (IMAGE.test(file.type) || /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(file.name)) {
    const logo = await imageToLogo(file);
    const palette = await paletteFromImage(logo);
    let svgColors: string[] = [];
    if (/svg/.test(file.type) || /\.svg$/i.test(file.name)) svgColors = colorsInText(await file.text()).palette;
    const merged = dedupe([...svgColors, ...palette]);
    return { logo, palette: merged, accent: pickAccent(merged), source: file.name };
  }
  const { fileText } = await import("./images");
  const text = await fileText(file);
  const found = colorsInText(text);
  const html: { name?: string; accent?: string } = /\.html?$/i.test(file.name) ? metaFromHtml(text, "") : {};
  return {
    ...found,
    ...html,
    accent: html.accent ?? found.accent ?? pickAccent(found.palette),
    text: text.slice(0, 20_000),
    source: file.name,
  };
}

/** Learn a brand from a website: name, logo/icon, theme colour and CSS colours. */
export async function brandFromWebsite(input: string, useProxy: boolean): Promise<BrandSuggestion> {
  const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  const res = await providerFetch(url.toString(), { method: "GET", headers: { accept: "text/html" } }, useProxy).catch(() => {
    throw new Error("Couldn't load that website. Website import needs the desktop app or the self-hosted web version.");
  });
  if (!res.ok) throw new Error(`The website answered ${res.status}.`);
  const html = await res.text();
  const meta = metaFromHtml(html, url.toString());
  // Inline styles plus the first two stylesheets.
  let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  for (const href of meta.stylesheets.slice(0, 2)) {
    const sheet = await providerFetch(href, { method: "GET", headers: { accept: "text/css" } }, useProxy).catch(() => null);
    if (sheet?.ok) css += `\n${(await sheet.text()).slice(0, 400_000)}`;
  }
  const fromCss = colorsInText(css);
  let logo: string | undefined;
  let logoPalette: string[] = [];
  for (const icon of meta.icons) {
    try {
      const image = await providerFetch(icon, { method: "GET", headers: { accept: "image/*" } }, useProxy);
      if (!image.ok) continue;
      const blob = await image.blob();
      if (!blob.type.startsWith("image/") && !/\.(png|svg|jpe?g|webp|ico)(\?|$)/i.test(icon)) continue;
      logo = await imageToLogo(new File([blob], "logo", { type: blob.type || "image/png" }));
      logoPalette = await paletteFromImage(logo);
      break;
    } catch {
      // Try the next icon.
    }
  }
  const palette = dedupe([...(meta.accent ? [meta.accent] : []), ...fromCss.palette, ...logoPalette]);
  return {
    name: meta.name,
    logo,
    accent: meta.accent ?? fromCss.accent ?? pickAccent(logoPalette) ?? pickAccent(palette),
    background: fromCss.background,
    font: fromCss.font,
    palette,
    source: url.hostname,
  };
}

/** When a document describes a brand in words (e.g. "Pantone 286 C, warm sand"), ask the active model. */
export async function brandFromTextWithAI(text: string): Promise<BrandSuggestion> {
  const { bots, activeBotId, providers, settings } = useStore.getState();
  const bot = bots.find((b) => b.id === activeBotId) ?? bots[0];
  const provider = providers.find((p) => p.id === bot?.providerId);
  if (!bot || !provider) throw new Error("Connect a provider first, so the AI can read the document.");
  const reply = await complete({
    provider,
    model: bot.model,
    system: "You are a brand designer. Reply with JSON only.",
    messages: [
      {
        id: "brand",
        role: "user",
        createdAt: 0,
        content:
          'From this brand or company document, return {"name": string, "accent": "#rrggbb", "background": "#rrggbb" or "", "font": string or ""}. ' +
          "Accent is the main brand colour for buttons and links. Only give a background if the brand clearly uses one. " +
          `Convert Pantone/CMYK/colour names to hex.\n\n${text.slice(0, 12_000)}`,
      },
    ],
    useProxy: settings.useProxy,
    signal: AbortSignal.timeout(60_000),
  });
  const json = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? "{}");
  const accent = normalizeHex(String(json.accent ?? "")) ?? undefined;
  const background = normalizeHex(String(json.background ?? "")) ?? undefined;
  return {
    name: typeof json.name === "string" && json.name ? json.name : undefined,
    accent,
    background,
    font: typeof json.font === "string" ? json.font : undefined,
    palette: dedupe([accent, background].filter((c): c is string => Boolean(c))),
    source: "AI",
  };
}

// Extraction helpers ---------------------------------------------------------------

/** Colours in CSS, design tokens, SVG, documents. Brand-named variables win. */
export function colorsInText(input: string): { palette: string[]; accent?: string; background?: string; font?: string } {
  const text = input.slice(0, 400_000);
  const counts = new Map<string, number>();
  const pattern = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\([^)]+\)|hsla?\([^)]+\)/gi;
  for (const match of text.matchAll(pattern)) {
    const hex = normalizeHex(match[0]);
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  // Every "name: colour" pair once, in a single pass (a pattern that searched for the name inside
  // the variable took minutes on a large stylesheet), then the first whose name says what it is.
  const pairs = [...text.matchAll(/(-{0,2}[\w-]{1,80})["']?\s*[:=]\s*["']?(#[0-9a-f]{3,6}\b|rgba?\([^)]{0,80}\)|hsla?\([^)]{0,80}\))/gi)];
  const named = (names: string) => {
    const wanted = new RegExp(names, "i");
    const hit = pairs.find((m) => wanted.test(m[1]));
    return hit ? (normalizeHex(hit[2]) ?? undefined) : undefined;
  };
  const accent = named("brand|primary|accent|main|theme");
  const background = named("background|bg|surface|page");
  const fontMatch = /font-family\s*:\s*["']?([^"',;}]+)/i.exec(text) ?? /"font(?:Family|-family)?"\s*:\s*"([^"]+)"/i.exec(text);
  const palette = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex);
  return {
    palette: dedupe([...(accent ? [accent] : []), ...palette]).slice(0, 12),
    accent,
    background: background && background !== accent ? background : undefined,
    font: fontMatch?.[1]?.trim(),
  };
}

function metaFromHtml(html: string, base: string): { name?: string; accent?: string; icons: string[]; stylesheets: string[] } {
  const attr = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const metaContent = (key: string) =>
    metas.map((tag) => ((attr(tag, "name") ?? attr(tag, "property"))?.toLowerCase() === key ? attr(tag, "content") : undefined)).find(Boolean);
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  const name = metaContent("og:site_name") ?? metaContent("application-name") ?? title?.split(/\s[|–—-]\s/)[0]?.trim();
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const resolve = (href: string) => {
    try {
      return new URL(href, base || undefined).toString();
    } catch {
      return "";
    }
  };
  const icons = [
    ...links.filter((l) => /apple-touch-icon/i.test(attr(l, "rel") ?? "")),
    ...links.filter((l) => /\bicon\b/i.test(attr(l, "rel") ?? "") && /svg|png/i.test(`${attr(l, "type")} ${attr(l, "href")}`)),
    ...links.filter((l) => /\bicon\b/i.test(attr(l, "rel") ?? "")),
  ]
    .map((l) => resolve(attr(l, "href") ?? ""))
    .filter(Boolean);
  const ogImage = metaContent("og:image");
  if (ogImage) icons.push(resolve(ogImage));
  if (base) icons.push(resolve("/favicon.ico"));
  const stylesheets = links
    .filter((l) => /stylesheet/i.test(attr(l, "rel") ?? ""))
    .map((l) => resolve(attr(l, "href") ?? ""))
    .filter(Boolean);
  return {
    name: name ? decode(name) : undefined,
    accent: normalizeHex(metaContent("theme-color") ?? "") ?? undefined,
    icons: [...new Set(icons)],
    stylesheets,
  };
}

function decode(text: string) {
  return text.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
}

/** Square, max 256 px PNG data URL (keeps transparency). */
async function imageToLogo(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const size = 256;
    const scale = Math.min(size / (img.naturalWidth || size), size / (img.naturalHeight || size), 4);
    const w = Math.max(1, Math.round((img.naturalWidth || size) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || size) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    canvas.getContext("2d")!.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Prominent colours in an image, ignoring transparency and near-white/black/grey pixels. */
export async function paletteFromImage(dataUrl: string): Promise<string[]> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, 64, 64);
  const { data } = ctx.getImageData(0, 0, 64, 64);
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const rgb: [number, number, number] = [data[i], data[i + 1], data[i + 2]];
    const [h, s, l] = rgbToHsl(rgb);
    if (s < 0.18 || l < 0.08 || l > 0.94) continue;
    const key = `${Math.round(h / 15)}-${Math.round(s * 4)}-${Math.round(l * 5)}`;
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count++;
    bucket.r += rgb[0];
    bucket.g += rgb[1];
    bucket.b += rgb[2];
    buckets.set(key, bucket);
  }
  return dedupe(
    [...buckets.values()]
      .sort((a, b) => b.count - a.count)
      .map((b) => toHex([b.r / b.count, b.g / b.count, b.b / b.count])),
  ).slice(0, 8);
}

/** The palette colour best suited for buttons and links: saturated and not too light or dark. */
export function pickAccent(palette: string[]): string | undefined {
  const scored = palette
    .map((hex, i) => {
      const [, s, l] = rgbToHsl(parseColor(hex)!);
      const usable = Math.min(contrast(hex, "#ffffff"), contrast(hex, "#0b0c0e"));
      return { hex, score: s * 2 + (1 - Math.abs(l - 0.5)) + usable * 0.15 - i * 0.05 };
    })
    .filter((c) => {
      const [, s] = rgbToHsl(parseColor(c.hex)!);
      return s > 0.2 && luminance(c.hex) < 0.85;
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.hex;
}

/** Drops near-duplicate colours. */
function dedupe(colors: string[]): string[] {
  const out: string[] = [];
  for (const color of colors) {
    const rgb = parseColor(color);
    if (!rgb) continue;
    if (out.every((c) => distance(parseColor(c)!, rgb) > 28)) out.push(toHex(rgb));
  }
  return out;
}

function distance(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
