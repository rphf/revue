// Apple keyboards say ⌘ where others say Ctrl.
export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);
