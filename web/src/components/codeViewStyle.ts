// Shared CodeView styling for the diff pane and the snapshot view.

// GitHub's own Shiki themes for the code; the surrounding chrome is
// the app palette. The -default variants are GitHub's current colors
// and their backgrounds sit next to the neutral page without a seam.
export const THEMES = {
  light: "github-light-default",
  dark: "github-dark-default",
};

// Item spacing lives in the CodeView layout, not in CSS, so the
// virtualizer's offsets and the painted gaps agree. The bottom padding
// lets the last file scroll to the top of the pane.
export const LAYOUT = { paddingTop: 12, paddingBottom: 480, gap: 16 };

// Room kept above a line scrolled to, in pixels: about three lines of
// context before it.
export const LINE_SCROLL_OFFSET = 72;

// Each file renders in its own shadow root; this is the one way to give
// it a card outline. The app's border token inherits through the
// shadow boundary. The card clips its own corners, so the header stays
// square: stuck at the top of the pane, it hides the code scrolling
// under it edge to edge. overflow: clip, unlike hidden, makes no scroll
// container, so the header still sticks to the pane. The library prints
// the header's line counts as -N +N; the order puts +N first, as in the
// file tree header. File items are a rendered markdown document or a
// binary preview over a one-line caption, so their line-number gutter
// only takes room.
export const UNSAFE_CSS = `
:host { border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: clip; }
[data-additions-count] { order: -1; }
[data-file] [data-code] { grid-template-columns: 0 minmax(0, 1fr); }
[data-file] [data-gutter] { display: none; }
[data-file] [data-line] { padding-inline: 1.5rem; }
`;

// The options the diff pane and the snapshot view share. Long lines
// soft-wrap inside their column instead of clipping behind a horizontal
// scrollbar; prose and 80-column docs read whole in split view.
export const BASE_OPTIONS = {
  stickyHeaders: true,
  overflow: "wrap",
  expansionLineCount: 20,
  layout: LAYOUT,
  unsafeCSS: UNSAFE_CSS,
  theme: THEMES,
} as const;
