import type { Thread } from "../types";

// threadRev fingerprints a thread's visible content so annotation
// equality can tell "same anchor, changed conversation" apart.
export function threadRev(t: Thread): string {
  return `${t.resolved ? 1 : 0}|${t.comments.map((c) => `${c.id}#${c.draft ? 1 : 0}#${c.body}`).join("\u0000")}`;
}

// Where a thread points: `path:line`, or the bare path for one on the
// file as a whole (line 0).
export function locationLabel(path: string, line: number): string {
  return line === 0 ? path : `${path}:${line}`;
}

// A branch by name, or what stands in for one on a detached HEAD.
export const branchLabel = (name: string) => name || "(detached HEAD)";
