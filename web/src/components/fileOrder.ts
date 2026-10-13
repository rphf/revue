import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import type { DiffFile } from "../types";
import type { AnnotationMeta } from "./DiffView";
import { treePathCompare } from "./treePath";

// fileOrder lists the files the diff pane shows, in the order it shows
// them: the changed files, binary ones included, and the files kept
// only for their outdated threads ("gone"), all in tree order.
export function fileOrder(
  files: FileDiffMetadata[],
  diffFiles: DiffFile[],
  annotationsByFile?: Map<string, DiffLineAnnotation<AnnotationMeta>[]>,
): { paths: string[]; gone: ReadonlySet<string> } {
  const inDiff = new Set([
    ...files.map((f) => f.name),
    ...diffFiles.filter((f) => f.isBinary).map((f) => f.path),
  ]);
  const gone = new Set(
    [...(annotationsByFile?.entries() ?? [])]
      .filter(
        ([path, list]) =>
          !inDiff.has(path) &&
          list.some((a) => a.metadata?.kind === "outdated"),
      )
      .map(([path]) => path),
  );
  return {
    paths: [...inDiff, ...gone].sort(treePathCompare),
    gone,
  };
}
