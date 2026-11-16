// A key typed into a text box is text, not a shortcut. The event's
// first target is read through shadow roots, where the diff lives.
export function isTyping(e: KeyboardEvent): boolean {
  const el = e.composedPath()[0] ?? e.target;
  return (
    el instanceof HTMLElement &&
    (el.isContentEditable ||
      el.closest("input, textarea, select, [contenteditable]") !== null)
  );
}

// Enter on a focused button or link already clicks it.
export function onControl(e: KeyboardEvent): boolean {
  const el = e.composedPath()[0] ?? e.target;
  return (
    el instanceof HTMLElement &&
    el.closest("button, a[href], [role='button']") !== null
  );
}
