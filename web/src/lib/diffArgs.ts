// The diff arguments live in the query string as repeated `arg`
// parameters, so a URL names exactly one diff and two tabs can show two.

export function argsFromSearch(search: string): string[] {
  return new URLSearchParams(search).getAll("arg");
}

export function pathForArgs(args: string[]): string {
  const q = new URLSearchParams();
  for (const a of args) q.append("arg", a);
  const s = q.toString();
  return s === "" ? "/" : `/?${s}`;
}

// What the top bar calls a diff: the two presets by name, anything
// else by its arguments.
export function diffLabel(args: string[]): string {
  if (args.length === 0) return "uncommitted";
  if (args.length === 1 && (args[0] === "--staged" || args[0] === "--cached"))
    return "staged";
  return args.join(" ");
}

export function sameArgs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
