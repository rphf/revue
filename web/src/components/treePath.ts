// treePathCompare orders leaf paths exactly as the rendered tree
// flattens them: at the first differing component, directories sort
// before files, then names compare locale-wise. The diff pane sorts
// its file cards with this so tree order and diff order always match.
export function treePathCompare(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    if (as[i] === bs[i]) continue;
    const aIsDir = i < as.length - 1;
    const bIsDir = i < bs.length - 1;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return as[i].localeCompare(bs[i]);
  }
  return as.length - bs.length;
}
