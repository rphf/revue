import { useEffect, useState } from "react";
import { processFile } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { api } from "../api";
import type { RoundFile } from "../types";

// Hunk-context expansion (R25): upgrade each partial diff to a full
// one with old/new contents served from the round's frozen snapshot —
// never the live tree. A full diff lets @pierre/diffs render its
// expand-context affordances; DiffView keys on isPartial so the
// upgrade forces a remount (virtualizer constraint).

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

export function useFullDiffs(
  reviewId: number,
  roundSeq: number | null,
  parsed: FileDiffMetadata[] | null,
  roundFiles: RoundFile[],
  patch: string | null,
): FileDiffMetadata[] | null {
  const [upgraded, setUpgraded] = useState<Map<string, FileDiffMetadata>>(new Map());

  useEffect(() => {
    // New round (or review): drop upgrades from the previous one.
    setUpgraded(new Map());
    if (roundSeq === null || parsed === null || patch === null) return;

    const sections = splitPatch(patch);
    const binary = new Set(roundFiles.filter((f) => f.isBinary).map((f) => f.path));
    let cancelled = false;

    for (const file of parsed) {
      if (!file.isPartial || binary.has(file.name)) continue;
      const section = sections.get(file.name);
      if (!section) continue;
      api
        .getFileVersions(reviewId, roundSeq, file.name)
        .then((versions) => {
          if (cancelled) return;
          const full = processFile(section, {
            cacheKey: `${reviewId}:${roundSeq}:${file.name}:full`,
            oldFile:
              versions.oldContent !== null
                ? { name: versions.oldPath || file.name, contents: versions.oldContent }
                : undefined,
            newFile: versions.newContent !== null ? { name: file.name, contents: versions.newContent } : undefined,
          });
          if (full) {
            setUpgraded((prev) => {
              const next = new Map(prev);
              next.set(file.name, full);
              return next;
            });
          }
        })
        .catch(() => {
          // Expansion is progressive enhancement; the partial diff
          // stays perfectly reviewable.
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId, roundSeq, parsed, patch]);

  if (parsed === null) return null;
  return parsed.map((f) => upgraded.get(f.name) ?? f);
}
