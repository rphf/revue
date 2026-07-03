import { memo, type ReactNode } from "react";
import type { FileDiffMetadata, DiffLineAnnotation } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import type { RoundFile, Side } from "../types";
import type { Theme } from "../theme";
import { treePathCompare } from "./FileTree";

export type DiffStyle = "unified" | "split";

// Metadata attached to each annotation; U6 renders threads and
// pending comment forms through it.
export interface AnnotationMeta {
  kind: "thread" | "pending";
  threadId?: number;
}

export interface DiffViewProps {
  files: FileDiffMetadata[];
  roundFiles: RoundFile[];
  diffStyle: DiffStyle;
  theme: Theme;
  annotationsByFile?: Map<string, DiffLineAnnotation<AnnotationMeta>[]>;
  renderAnnotation?: (annotation: DiffLineAnnotation<AnnotationMeta>, path: string) => ReactNode;
  onGutterAdd?: (path: string, side: Side, lineNumber: number) => void;
}

// One FileDiff per file under the Virtualizer, which owns scrolling
// (never nest it in another overflow container). Binary files render
// as stat-only rows (R24); an empty diff renders the empty state.
export default function DiffView({
  files,
  roundFiles,
  diffStyle,
  theme,
  annotationsByFile,
  renderAnnotation,
  onGutterAdd,
}: DiffViewProps) {
  // Cards render in the exact order the tree lists files — binary
  // stat rows interleaved in place, not grouped first.
  const binaryByPath = new Map(roundFiles.filter((f) => f.isBinary).map((f) => [f.path, f]));
  type RenderItem = { path: string; binary?: RoundFile; meta?: FileDiffMetadata };
  const items: RenderItem[] = [
    ...[...binaryByPath.values()].map((f) => ({ path: f.path, binary: f })),
    ...files.filter((f) => !binaryByPath.has(f.name)).map((f) => ({ path: f.name, meta: f })),
  ].sort((a, b) => treePathCompare(a.path, b.path));

  if (items.length === 0) {
    return (
      <div className="diff-empty" data-testid="diff-empty">
        <p>No changes in this diff</p>
      </div>
    );
  }

  return (
    <Virtualizer className="diff-scroll" contentClassName="diff-content">
      {items.map((item) =>
        item.binary ? (
          <BinaryRow key={`bin:${item.path}`} file={item.binary} />
        ) : (
          <MemoFileDiff
            key={item.path}
            file={item.meta!}
            diffStyle={diffStyle}
            theme={theme}
            annotations={annotationsByFile?.get(item.path)}
            renderAnnotation={renderAnnotation}
            onGutterAdd={onGutterAdd}
          />
        ),
      )}
    </Virtualizer>
  );
}

function BinaryRow({ file }: { file: RoundFile }) {
  return (
    <div className="binary-row" data-testid={`binary-${file.path}`} id={fileDomId(file.path)}>
      <span className="binary-path">{file.path}</span>
      <span className="binary-note">Binary file ({file.status}) — no diff shown</span>
    </div>
  );
}

export function fileDomId(path: string): string {
  // Stable, CSS-safe DOM id for tree click-to-scroll.
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  return `file-${hash.toString(36)}`;
}

interface FileDiffCardProps {
  file: FileDiffMetadata;
  diffStyle: DiffStyle;
  theme: Theme;
  annotations?: DiffLineAnnotation<AnnotationMeta>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<AnnotationMeta>, path: string) => ReactNode;
  onGutterAdd?: (path: string, side: Side, lineNumber: number) => void;
}

const MemoFileDiff = memo(function FileDiffCard({
  file,
  diffStyle,
  theme,
  annotations,
  renderAnnotation,
  onGutterAdd,
}: FileDiffCardProps) {
  return (
    // Key includes isPartial: the virtualized FileDiff does not
    // re-process in-place fileDiff changes, so the partial->full
    // upgrade (U9 context expansion) must force a remount.
    <div id={fileDomId(file.name)} className="file-diff-card" data-file-path={file.name}>
      <FileDiff<AnnotationMeta>
        key={`${file.name}:${file.isPartial ? "partial" : "full"}`}
        fileDiff={file}
        options={{
          diffStyle,
          stickyHeader: true,
          expansionLineCount: 20,
          enableGutterUtility: Boolean(onGutterAdd),
          theme: { dark: "github-dark", light: "github-light" },
          themeType: theme,
        }}
        lineAnnotations={annotations}
        renderAnnotation={renderAnnotation ? (a) => renderAnnotation(a, file.name) : undefined}
        renderGutterUtility={
          onGutterAdd
            ? (getHoveredLine) => (
                <button
                  type="button"
                  className="gutter-add"
                  aria-label="Add comment"
                  onClick={() => {
                    const line = getHoveredLine();
                    if (line) onGutterAdd(file.name, line.side as Side, line.lineNumber);
                  }}
                >
                  +
                </button>
              )
            : undefined
        }
      />
    </div>
  );
});
