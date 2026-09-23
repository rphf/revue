// Revue's one definition of file order: the sidebar tree sorts with
// treeEntryCompare and the diff pane sorts its file cards with
// treePathCompare, so both panes always list files the same way. At the
// first differing component, directories come before files,
// dot-prefixed names before the rest, then a case-insensitive locale
// compare (case-sensitive as the tie break).

export interface TreeSortEntry {
  segments: readonly string[];
  isDirectory: boolean;
}

export function treeEntryCompare(a: TreeSortEntry, b: TreeSortEntry): number {
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const as = a.segments[i];
    const bs = b.segments[i];
    if (as === bs) continue;
    const aIsDir = i < a.segments.length - 1 || a.isDirectory;
    const bIsDir = i < b.segments.length - 1 || b.isDirectory;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    const aIsDot = as.startsWith(".");
    const bIsDot = bs.startsWith(".");
    if (aIsDot !== bIsDot) return aIsDot ? -1 : 1;
    const folded = as.toLowerCase().localeCompare(bs.toLowerCase());
    if (folded !== 0) return folded;
    return as.localeCompare(bs);
  }
  if (a.segments.length !== b.segments.length) {
    return a.segments.length - b.segments.length;
  }
  if (a.isDirectory === b.isDirectory) return 0;
  return a.isDirectory ? -1 : 1;
}

// Orders leaf file paths.
export function treePathCompare(a: string, b: string): number {
  return treeEntryCompare(
    { segments: a.split("/"), isDirectory: false },
    { segments: b.split("/"), isDirectory: false },
  );
}
