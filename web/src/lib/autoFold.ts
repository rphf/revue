import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffFile, FoldReason } from "../types";

const AUTO_FOLD_KEY = "revue-auto-fold-off";

// A file with more changed lines than this starts folded, as GitHub
// folds a large diff.
export const LARGE_DIFF_LINES = 1000;

export function loadAutoFold(): boolean {
  try {
    return localStorage.getItem(AUTO_FOLD_KEY) !== "1";
  } catch {
    return true;
  }
}

export function saveAutoFold(on: boolean): void {
  try {
    if (on) localStorage.removeItem(AUTO_FOLD_KEY);
    else localStorage.setItem(AUTO_FOLD_KEY, "1");
  } catch {
    // Not remembering the choice is fine.
  }
}

// changedLines counts the added and deleted lines of a parsed file.
export function changedLines(file: FileDiffMetadata): number {
  let n = 0;
  for (const h of file.hunks) n += h.additionLines + h.deletionLines;
  return n;
}

// autoFolds names the files that start folded and why: those
// .gitattributes marks generated or vendored, then the large ones.
// Binary files have no lines to fold.
export function autoFolds(
  files: readonly FileDiffMetadata[],
  diffFiles: readonly DiffFile[],
): Map<string, FoldReason> {
  const out = new Map<string, FoldReason>();
  for (const f of diffFiles) {
    if (f.fold && !f.isBinary) out.set(f.path, f.fold);
  }
  for (const f of files) {
    if (!out.has(f.name) && changedLines(f) > LARGE_DIFF_LINES)
      out.set(f.name, "large");
  }
  return out;
}

export function foldNotice(reason: FoldReason): string {
  switch (reason) {
    case "generated":
      return "Generated file: not shown by default.";
    case "vendored":
      return "Vendored file: not shown by default.";
    case "large":
      return "Large diff: not shown by default.";
  }
}
