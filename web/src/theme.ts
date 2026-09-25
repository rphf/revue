export type Theme = "dark" | "light";

const KEY = "revue-theme";

export function loadTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
    ? "dark"
    : "light";
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  document.documentElement.dataset.theme = theme;
}

// shadcn's base colors and accent themes, as ui.shadcn.com/init serves
// them; appearance.css holds their tokens, under data-palette and
// data-accent on <html>. Each maps to its swatch: the palette's light
// muted-foreground, the accent's light primary.
export const PALETTES = {
  neutral: "oklch(0.556 0 0)",
  zinc: "oklch(0.552 0.016 285.938)",
  stone: "oklch(0.553 0.013 58.071)",
  mauve: "oklch(0.542 0.034 322.5)",
  olive: "oklch(0.58 0.031 107.3)",
  mist: "oklch(0.56 0.021 213.5)",
  taupe: "oklch(0.547 0.021 43.1)",
} as const;
export const ACCENTS = {
  amber: "oklch(0.555 0.163 48.998)",
  blue: "oklch(0.488 0.243 264.376)",
  cyan: "oklch(0.52 0.105 223.128)",
  emerald: "oklch(0.508 0.118 165.612)",
  fuchsia: "oklch(0.518 0.253 323.949)",
  green: "oklch(0.527 0.154 150.069)",
  indigo: "oklch(0.457 0.24 277.023)",
  lime: "oklch(0.841 0.238 128.85)",
  orange: "oklch(0.553 0.195 38.402)",
  pink: "oklch(0.525 0.223 3.958)",
  purple: "oklch(0.496 0.265 301.924)",
  red: "oklch(0.505 0.213 27.518)",
  rose: "oklch(0.514 0.222 16.935)",
  sky: "oklch(0.5 0.134 242.749)",
  teal: "oklch(0.511 0.096 186.391)",
  violet: "oklch(0.491 0.27 292.581)",
  yellow: "oklch(0.852 0.199 91.936)",
} as const;

export type Palette = keyof typeof PALETTES;
export type Accent = "none" | keyof typeof ACCENTS;

export interface Appearance {
  palette: Palette;
  accent: Accent;
}

const APPEARANCE_KEY = "revue-appearance";

function choice<K extends string>(choices: Record<K, string>, v: unknown) {
  return typeof v === "string" && Object.hasOwn(choices, v)
    ? (v as K)
    : undefined;
}

export function loadAppearance(): Appearance {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "{}");
  } catch {
    // An unreadable value keeps the defaults.
  }
  return {
    palette: choice(PALETTES, stored.palette) ?? "neutral",
    accent: choice(ACCENTS, stored.accent) ?? "none",
  };
}

export function saveAppearance(appearance: Appearance): void {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
  document.documentElement.dataset.palette = appearance.palette;
  document.documentElement.dataset.accent = appearance.accent;
}
