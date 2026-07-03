export type Theme = "dark" | "light";

const KEY = "revue-theme";

export function loadTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  document.documentElement.dataset.theme = theme;
}
