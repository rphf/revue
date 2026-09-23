// The diff arguments live in the query string as repeated `arg`
// parameters, so a URL names exactly one diff and two tabs can show two.

export function argsFromSearch(search: string): string[] {
  return new URLSearchParams(search).getAll("arg");
}

// One `arg` parameter per argument, so pathspecs with spaces survive the
// round trip; the page URL and the API calls share the encoding.
export function argsQuery(
  args: string[],
  extra?: Record<string, string>,
): string {
  const q = new URLSearchParams();
  for (const a of args) q.append("arg", a);
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

export function pathForArgs(args: string[]): string {
  return `/${argsQuery(args)}`;
}

// A string that names one list of arguments, for memo and effect keys:
// equal lists give equal keys whatever their identity.
export function keyForArgs(args: string[]): string {
  return JSON.stringify(args);
}

export function argsForKey(key: string): string[] {
  return JSON.parse(key) as string[];
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
