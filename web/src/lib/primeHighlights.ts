import { useEffect } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { useWorkerPool } from "@pierre/diffs/react";

// The lines highlighted ahead of time at most, and the files: the
// worker pool keeps the last PRIME_FILES results.
const PRIME_LINES = 40_000;
export const PRIME_FILES = 300;

// usePrimedHighlights highlights the files of the diff before they
// render, in the order given, so a file stepped or scrolled to paints
// in color on its first frame. One file at a time: the other workers
// stay free for the files on screen.
export function usePrimedHighlights(files: FileDiffMetadata[] | null): void {
  const pool = useWorkerPool();
  useEffect(() => {
    if (!pool || !files) return;
    let cancelled = false;
    void (async () => {
      let lines = 0;
      for (const file of files.slice(0, PRIME_FILES)) {
        lines += file.unifiedLineCount;
        if (cancelled || lines > PRIME_LINES) return;
        try {
          await pool.primeDiffHighlightCache(file);
        } catch {
          // No working pool: files highlight on the main thread as
          // they render.
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pool, files]);
}
