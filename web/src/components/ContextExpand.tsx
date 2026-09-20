import { useCallback, useMemo, useRef, useState } from "react";
import { processFile } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { api } from "../api";
import type { DiffFile } from "../types";

// Hunk-context expansion: upgrade a partial diff to a full one with
// old/new contents from the current capture. Upgrades are LAZY and per
// file (the reviewer asks via the file header button): upgrading
// eagerly re-processed and remounted every file diff on load, which
// made large diffs lag. A full diff lets @pierre/diffs render its
// expand-context affordances; DiffView keys on isPartial so the
// upgrade remounts.

// splitPatch slices a multi-file git patch into per-file sections so
// processFile can re-parse one file with full contents attached.
export function splitPatch(patch: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = patch.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) continue;
    const newName = part.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    const oldName = part.match(/^--- a\/(.+)$/m)?.[1];
    const name = newName ?? oldName;
    if (name) sections.set(name, part);
  }
  return sections;
}

export interface FullDiffs {
  files: FileDiffMetadata[] | null;
  // requestUpgrade fetches both versions of one file and swaps its
  // diff for the full one. No-op for binary files, unknown paths, and
  // files already upgraded or in flight.
  requestUpgrade: (path: string) => void;
}

export function useFullDiffs(
  args: string[],
  version: number | null,
  parsed: FileDiffMetadata[] | null,
  diffFiles: DiffFile[],
  patch: string | null,
): FullDiffs {
  // Keys carry the diff arguments and the capture version: a refreshed
  // diff starts over, since the contents it serves may have changed.
  const scope = `${JSON.stringify(args)}:${version}`;
  const [upgraded, setUpgraded] = useState<Map<string, FileDiffMetadata>>(
    new Map(),
  );
  const inFlight = useRef<Set<string>>(new Set());

  const requestUpgrade = useCallback(
    (path: string) => {
      if (version === null || patch === null) return;
      const key = `${scope}:${path}`;
      if (inFlight.current.has(key)) return;
      if (diffFiles.some((f) => f.path === path && f.isBinary)) return;
      const section = splitPatch(patch).get(path);
      if (!section) return;
      inFlight.current.add(key);
      api
        .getDiffFile(args, path)
        .then((versions) => {
          const full = processFile(section, {
            cacheKey: `${scope}:${path}:full`,
            oldFile:
              versions.oldContent !== null
                ? {
                    name: versions.oldPath || path,
                    contents: versions.oldContent,
                  }
                : undefined,
            newFile:
              versions.newContent !== null
                ? { name: path, contents: versions.newContent }
                : undefined,
          });
          if (full) {
            setUpgraded((prev) => {
              const next = new Map(prev);
              next.set(key, full);
              return next;
            });
          }
        })
        .catch(() => {
          // Expansion is progressive enhancement; allow a retry.
          inFlight.current.delete(key);
        });
    },
    [args, version, patch, diffFiles, scope],
  );

  const files = useMemo(() => {
    if (parsed === null) return null;
    return parsed.map((f) => upgraded.get(`${scope}:${f.name}`) ?? f);
  }, [parsed, upgraded, scope]);

  return { files, requestUpgrade };
}
