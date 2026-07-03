import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { processFile } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { api } from "../api";
import type { RoundFile } from "../types";

// Hunk-context expansion (R25): upgrade a partial diff to a full one
// with old/new contents served from the round's frozen snapshot —
// never the live tree. Upgrades are LAZY and per file (the reviewer
// asks via the file header button): upgrading eagerly re-processed and
// remounted every file diff on load, which made large reviews lag.
// A full diff lets @pierre/diffs render its expand-context
// affordances; DiffView keys on isPartial so the upgrade remounts.

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
  // requestUpgrade fetches snapshot contents for one file and swaps
  // its diff for the full version. No-op for binary files, unknown
  // paths, and files already upgraded or in flight.
  requestUpgrade: (path: string) => void;
}

export function useFullDiffs(
  reviewId: number,
  roundSeq: number | null,
  parsed: FileDiffMetadata[] | null,
  roundFiles: RoundFile[],
  patch: string | null,
): FullDiffs {
  const [upgraded, setUpgraded] = useState<Map<string, FileDiffMetadata>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  // New round (or review): drop upgrades from the previous one.
  useEffect(() => {
    setUpgraded(new Map());
    inFlight.current = new Set();
  }, [reviewId, roundSeq, patch]);

  const requestUpgrade = useCallback(
    (path: string) => {
      if (roundSeq === null || patch === null) return;
      if (inFlight.current.has(path)) return;
      if (roundFiles.some((f) => f.path === path && f.isBinary)) return;
      const section = splitPatch(patch).get(path);
      if (!section) return;
      inFlight.current.add(path);
      api
        .getFileVersions(reviewId, roundSeq, path)
        .then((versions) => {
          const full = processFile(section, {
            cacheKey: `${reviewId}:${roundSeq}:${path}:full`,
            oldFile:
              versions.oldContent !== null
                ? { name: versions.oldPath || path, contents: versions.oldContent }
                : undefined,
            newFile: versions.newContent !== null ? { name: path, contents: versions.newContent } : undefined,
          });
          if (full) {
            setUpgraded((prev) => {
              const next = new Map(prev);
              next.set(path, full);
              return next;
            });
          }
        })
        .catch(() => {
          // Expansion is progressive enhancement; allow a retry.
          inFlight.current.delete(path);
        });
    },
    [reviewId, roundSeq, patch, roundFiles],
  );

  const files = useMemo(() => {
    if (parsed === null) return null;
    return parsed.map((f) => upgraded.get(f.name) ?? f);
  }, [parsed, upgraded]);

  return { files, requestUpgrade };
}
