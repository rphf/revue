// treePathCompare orders leaf paths exactly as @pierre/trees lays them
// out with its default sort: at the first differing component,
// directories come before files, dot-prefixed names before the rest,
// then a case-insensitive locale compare (case-sensitive as the tie
// break). The diff pane sorts its file cards with this so tree order
// and diff order always match.
export function treePathCompare(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    if (as[i] === bs[i]) continue;
    const aIsDir = i < as.length - 1;
    const bIsDir = i < bs.length - 1;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    const aIsDot = as[i].startsWith(".");
    const bIsDot = bs[i].startsWith(".");
    if (aIsDot !== bIsDot) return aIsDot ? -1 : 1;
    const folded = as[i].toLowerCase().localeCompare(bs[i].toLowerCase());
    if (folded !== 0) return folded;
    return as[i].localeCompare(bs[i]);
  }
  return as.length - bs.length;
}
