// Shared CodeView styling for the diff pane and the snapshot dialog.

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

// Each file renders in its own shadow root; this is the one way to give
// it a card outline. The app's border token inherits through the
// shadow boundary. No overflow clipping, or the sticky header stops
// sticking.
export const UNSAFE_CSS = `
:host { border: 1px solid var(--border); border-radius: var(--radius-lg); }
[data-diffs-header] { border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
[data-diff], [data-file] { border-radius: 0 0 var(--radius-lg) var(--radius-lg); }
`;
