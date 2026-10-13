import { useCallback, useEffect, useMemo, useState } from "react";

const PREFIX = "revue-viewed:";

// fingerprints names each file's change in a patch by its section's
// index line: the blob ids on either side, which stay the same when
// whitespace is hidden and move with any edit. A section without one (a
// pure rename, a mode change) is its own fingerprint. Sections are named
// by their +++ or --- line; a binary file has neither, so its name comes
// from the header, matched against the paths the diff lists.
export function fingerprints(
  patch: string,
  paths: readonly string[] = [],
): Map<string, string> {
  const prints = new Map<string, string>();
  for (const part of patch.split(/^(?=diff --git )/m)) {
    if (!part.startsWith("diff --git ")) continue;
    const header = part.split("\n", 1)[0];
    const name =
      part.match(/^\+\+\+ b\/(.+)$/m)?.[1] ??
      part.match(/^--- a\/(.+)$/m)?.[1] ??
      paths.find((p) => header.endsWith(` b/${p}`));
    if (!name) continue;
    prints.set(name, part.match(/^index (.+)$/m)?.[1] ?? part);
  }
  return prints;
}

function loadMarks(key: string | null): ReadonlyMap<string, string> {
  if (key === null) return new Map();
  try {
    const raw = localStorage.getItem(key);
    const obj: unknown = raw ? JSON.parse(raw) : null;
    if (obj && typeof obj === "object")
      return new Map(
        Object.entries(obj).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      );
  } catch {
    // A mark that cannot be read is a file to look at again.
  }
  return new Map();
}

function saveMarks(key: string | null, marks: ReadonlyMap<string, string>) {
  if (key === null) return;
  try {
    if (marks.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(Object.fromEntries(marks)));
  } catch {
    // Not remembering the marks only loses them on reload.
  }
}

// useViewed keeps which files of a diff the reviewer marked viewed,
// across reloads: each mark holds the file's fingerprint when it was
// made, and a file whose change has moved on since reads as not viewed.
// A file the patch leaves out (whitespace only, or gone) keeps its mark
// until it comes back changed.
export function useViewed(
  repo: string | undefined,
  argsKey: string,
  patch: string | undefined,
  paths: readonly string[],
): {
  viewed: ReadonlySet<string>;
  toggleViewed: (path: string) => void;
} {
  const key = repo === undefined ? null : `${PREFIX}${repo}:${argsKey}`;
  const [state, setState] = useState(() => ({ key, marks: loadMarks(key) }));
  let marks = state.marks;
  if (state.key !== key) {
    marks = loadMarks(key);
    setState({ key, marks });
  }
  useEffect(() => saveMarks(state.key, state.marks), [state]);

  const prints = useMemo(
    () => fingerprints(patch ?? "", paths),
    [patch, paths],
  );
  const viewed = useMemo(
    () =>
      new Set(
        [...marks]
          .filter(([path, print]) => (prints.get(path) ?? "") === print)
          .map(([path]) => path),
      ),
    [marks, prints],
  );
  const toggleViewed = useCallback(
    (path: string) => {
      const print = prints.get(path) ?? "";
      setState((prev) => {
        const next = new Map(prev.marks);
        if (next.get(path) === print) next.delete(path);
        else next.set(path, print);
        return { key: prev.key, marks: next };
      });
    },
    [prints],
  );
  return { viewed, toggleViewed };
}
