import type { ThemeConfig } from "./types";

export const THEME_PRESETS: { id: string; name: string; accent: string; background: string }[] = [
  { id: "adt", name: "ADT Signal", accent: "#01F9C9", background: "#0A0A0A" },
  { id: "blue", name: "Blue", accent: "#3b82f6", background: "" },
  { id: "violet", name: "Violet", accent: "#8b5cf6", background: "" },
  { id: "emerald", name: "Emerald", accent: "#10b981", background: "" },
  { id: "sunset", name: "Sunset", accent: "#f97316", background: "" },
  { id: "rose", name: "Rose", accent: "#f43f5e", background: "" },
  { id: "teal", name: "Teal", accent: "#0d9488", background: "" },
  { id: "gold", name: "Gold", accent: "#d97706", background: "" },
  { id: "graphite", name: "Graphite", accent: "#71717a", background: "" },
  { id: "sand", name: "Navy & Sand", accent: "#1d4ed8", background: "#f6f0e6" },
  { id: "midnight", name: "Midnight", accent: "#22d3ee", background: "#0b1020" },
  { id: "forest", name: "Forest", accent: "#65a30d", background: "#0f1a14" },
  { id: "paper", name: "Paper", accent: "#be123c", background: "#fbfaf7" },
];

export const FONTS: Record<string, { label: string; stack: string; display?: string; mono?: string }> = {
  // ADT brand type, bundled in public/fonts (SIL Open Font License 1.1).
  adt: {
    label: "ADT (IBM Plex Sans + Space Grotesk)",
    stack: '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif',
    display: '"Space Grotesk", "Helvetica Neue", Arial, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
  },
  system: { label: "System", stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  humanist: { label: "Humanist", stack: '"Avenir Next", Avenir, "Segoe UI", "Trebuchet MS", Ubuntu, sans-serif' },
  rounded: { label: "Rounded", stack: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif' },
  serif: { label: "Serif", stack: 'ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, Cambria, serif' },
  geometric: { label: "Geometric", stack: '"Futura", "Century Gothic", "Gill Sans", "Segoe UI", sans-serif' },
  mono: { label: "Monospace", stack: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace' },
};

// Colour maths -----------------------------------------------------------------------

export function parseColor(input: string): [number, number, number] | null {
  const value = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(value);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((n) => Math.min(255, n)) as [number, number, number];
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(value);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
  return null;
}

export function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0")).join("")}`;
}

export function normalizeHex(input: string): string | null {
  const rgb = parseColor(input);
  return rgb ? toHex(rgb) : null;
}

export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

export function luminance(hex: string): number {
  const rgb = parseColor(hex) ?? [0, 0, 0];
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export function mix(a: string, b: string, amount: number): string {
  const x = parseColor(a) ?? [0, 0, 0];
  const y = parseColor(b) ?? [0, 0, 0];
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * amount) as [number, number, number]);
}

/** Lightens or darkens a colour until it reads well on the background (WCAG AA). */
export function readableOn(color: string, background: string, target = 4.5): string {
  const [h, s, l] = rgbToHsl(parseColor(color) ?? [59, 130, 246]);
  const darkBg = luminance(background) < 0.4;
  let lightness = l;
  for (let i = 0; i < 40 && contrast(toHex(hslToRgb(h, s, lightness)), background) < target; i++) {
    lightness = Math.max(0, Math.min(1, lightness + (darkBg ? 0.02 : -0.02)));
  }
  return toHex(hslToRgb(h, s, lightness));
}

/** Text colour for a filled button: white whenever it's readable (3:1, fine for bold UI text), else near-black. */
export function onColor(background: string): string {
  return contrast("#ffffff", background) >= 3 ? "#ffffff" : "#111111";
}

const NEUTRAL = { dark: "#0b0c0e", light: "#fafaf8" };

export function preferredMode(theme: ThemeConfig): "dark" | "light" | null {
  if (!theme.background || !parseColor(theme.background)) return null;
  return luminance(theme.background) < 0.35 ? "dark" : "light";
}

/** CSS variables for both modes, derived from the brand colours. */
export function themeCss(theme: ThemeConfig): string {
  const accent = normalizeHex(theme.accent) ?? "#3b82f6";
  const brandBg = normalizeHex(theme.background ?? "");
  const brandMode = preferredMode(theme);
  const block = (mode: "dark" | "light") => {
    const bg = brandBg && brandMode === mode ? brandBg : NEUTRAL[mode];
    const fg = mode === "dark" ? mix(bg, "#ffffff", 0.9) : mix(bg, "#000000", 0.88);
    const step = (amount: number) => mix(bg, mode === "dark" ? "#ffffff" : "#000000", amount);
    const link = readableOn(accent, bg);
    const primary = contrast(accent, bg) >= 3 ? accent : link;
    return `
  --background: ${bg};
  --foreground: ${fg};
  --card: ${mode === "dark" ? step(0.05) : mix(bg, "#ffffff", 0.7)};
  --secondary: ${step(mode === "dark" ? 0.07 : 0.04)};
  --accent: ${step(mode === "dark" ? 0.08 : 0.06)};
  --input: ${step(mode === "dark" ? 0.07 : 0.06)};
  --border: ${step(mode === "dark" ? 0.1 : 0.09)};
  --sidebar: ${step(mode === "dark" ? 0.03 : 0.05)};
  --scrollbar: ${step(mode === "dark" ? 0.12 : 0.2)};
  --code-bg: ${step(mode === "dark" ? 0.03 : 0.03)};
  --muted-foreground: ${mix(fg, bg, 0.45)};
  --chat-user: ${mix(step(mode === "dark" ? 0.1 : 0.08), accent, 0.14)};
  --primary: ${primary};
  --primary-foreground: ${onColor(primary)};
  --ring: ${link};
  --link: ${link};
  --orb-a: ${mix(accent, "#ffffff", 0.45)};
  --orb-b: ${accent};
  --orb-c: ${toHex(hslToRgb((rgbToHsl(parseColor(accent)!)[0] + 40) % 360, Math.max(0.5, rgbToHsl(parseColor(accent)!)[1]), 0.45))};`;
  };
  const preset = FONTS[theme.font];
  // Font names come from imported brand kits: keep only characters a family name needs, so the
  // value can't close the rule and inject CSS.
  const custom = typeof theme.font === "string" ? theme.font.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) : "";
  const font = preset?.stack ?? (custom ? `"${custom}", ${FONTS.system.stack}` : FONTS.system.stack);
  return `:root, [data-theme="dark"] {${block("dark")}
}
[data-theme="light"] {${block("light")}
}
:root {
  --radius: ${Math.max(0, Math.min(24, Number(theme.radius) || 0))}px;
  --font: ${font};
  --font-display: ${preset?.display ?? font};
  --font-mono: ${preset?.mono ?? 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace'};
}`;
}
