import type { Thread } from "../types";

// threadRev fingerprints a thread's visible content so annotation
// equality can tell "same anchor, changed conversation" apart.
export function threadRev(t: Thread): string {
  return `${t.resolved ? 1 : 0}|${t.comments.map((c) => `${c.id}#${c.draft ? 1 : 0}#${c.body}`).join("\u0000")}`;
}
