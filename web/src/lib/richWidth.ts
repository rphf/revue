// The width of a rendered markdown document, one setting for every
// file: a CSS variable on the page, so a drag resizes all of them
// without a render, and the width survives reloads.

const KEY = "revue-rich-width";
const VAR = "--rich-width";

export const MIN_RICH_WIDTH = 320;

// Null goes back to the default width.
export function applyRichWidth(px: number | null): void {
  const style = document.documentElement.style;
  if (px === null) style.removeProperty(VAR);
  else style.setProperty(VAR, `${Math.round(px)}px`);
}

export function saveRichWidth(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(px)));
  } catch {
    // Not remembering the width is fine.
  }
}

export function restoreRichWidth(): void {
  try {
    const px = Number(localStorage.getItem(KEY));
    if (px > 0) applyRichWidth(px);
  } catch {
    // The default width then.
  }
}
