import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type {
  CodeViewItem,
  CodeViewLineSelection,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import type { ReviewState, RoundFile, Side, Thread } from "../types";
import type { Theme } from "../theme";
import { treePathCompare } from "./treePath";

export type DiffStyle = "unified" | "split";

// Metadata attached to each annotation; U6 renders threads and
// pending comment forms through it. rev fingerprints the thread's
// visible content so item versions bump only when something changed.
export interface AnnotationMeta {
  kind: "thread" | "pending";
  threadId?: number;
  rev?: string;
  thread?: Thread;
  reviewState?: ReviewState;
  pending?: PendingComment;
}

export interface PendingComment {
  path: string;
  side: Side;
  line: number;
  startLine?: number;
}

// annotationsEqual compares what the annotations render, not their
// identity, so a rebuilt-but-unchanged list keeps its item version.
function annotationsEqual(
  a: DiffLineAnnotation<AnnotationMeta>[] | undefined,
  b: DiffLineAnnotation<AnnotationMeta>[] | undefined,
): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const ma = x[i].metadata;
    const mb = y[i].metadata;
    if (
      x[i].side !== y[i].side ||
      x[i].lineNumber !== y[i].lineNumber ||
      ma?.kind !== mb?.kind ||
      ma?.threadId !== mb?.threadId ||
      ma?.rev !== mb?.rev
    ) {
      return false;
    }
  }
  return true;
}

export interface DiffViewHandle {
  // Exact jump: CodeView computes the offset from its own layout
  // math, so far-away files land instantly with no settling.
  scrollToFile(path: string): void;
}

export interface DiffViewProps {
  files: FileDiffMetadata[];
  roundFiles: RoundFile[];
  diffStyle: DiffStyle;
  theme: Theme;
  annotationsByFile?: Map<string, DiffLineAnnotation<AnnotationMeta>[]>;
  renderAnnotation?: (
    annotation: DiffLineAnnotation<AnnotationMeta>,
    path: string,
  ) => ReactNode;
  onLineSelect?: (path: string, range: SelectedLineRange) => void;
  // Controlled selection: the highlighted lines follow the pending comment
  // and clear with it, so the next gutter click starts a fresh range.
  selectedLines?: CodeViewLineSelection | null;
  onExpandContext?: (path: string) => void;
}

interface ItemMemo {
  fileDiff: FileDiffMetadata;
  annotations?: DiffLineAnnotation<AnnotationMeta>[];
  version: number;
}

// The whole diff pane is ONE CodeView (the diffs.com architecture):
// every file is an item in a single virtualized list whose layout is
// computed from line counts up front — no per-file mounting or height
// measuring — and rows paint as plain text while highlighting streams
// in. Items render in tree order, binary files as stat-only header
// items in place (R24); an empty diff renders the empty state.
export default forwardRef<DiffViewHandle, DiffViewProps>(function DiffView(
  {
    files,
    roundFiles,
    diffStyle,
    theme,
    annotationsByFile,
    renderAnnotation,
    onLineSelect,
    selectedLines,
    onExpandContext,
  }: DiffViewProps,
  ref,
) {
  const codeView = useRef<CodeViewHandle<AnnotationMeta, undefined>>(null);
  useImperativeHandle(
    ref,
    () => ({
      scrollToFile: (path: string) => {
        codeView.current?.scrollTo({
          type: "item",
          id: path,
          align: "start",
          behavior: "instant",
        });
      },
    }),
    [],
  );

  const binaryByPath = useMemo(
    () => new Map(roundFiles.filter((f) => f.isBinary).map((f) => [f.path, f])),
    [roundFiles],
  );

  // Item versions bump only when a file's diff or its annotations
  // actually change, so CodeView re-processes exactly those items.
  const memoRef = useRef<Map<string, ItemMemo>>(new Map());

  const items = useMemo<CodeViewItem<AnnotationMeta>[]>(() => {
    const ordered = [
      ...files
        .filter((f) => !binaryByPath.has(f.name))
        .map((f) => ({ path: f.name, meta: f as FileDiffMetadata | null })),
      ...[...binaryByPath.keys()].map((path) => ({
        path,
        meta: null as FileDiffMetadata | null,
      })),
    ].sort((a, b) => treePathCompare(a.path, b.path));

    return ordered.map(({ path, meta }) => {
      if (meta === null) {
        // Binary: a header-only file item in its tree position.
        return {
          id: path,
          type: "file",
          file: { name: path, contents: "" },
        } as CodeViewItem<AnnotationMeta>;
      }
      const annotations = annotationsByFile?.get(path);
      const prev = memoRef.current.get(path);
      let version = prev?.version ?? 0;
      if (
        prev &&
        (prev.fileDiff !== meta ||
          !annotationsEqual(prev.annotations, annotations))
      )
        version++;
      memoRef.current.set(path, { fileDiff: meta, annotations, version });
      return {
        id: path,
        type: "diff",
        fileDiff: meta,
        annotations,
        version,
      } as CodeViewItem<AnnotationMeta>;
    });
  }, [files, binaryByPath, annotationsByFile]);

  if (items.length === 0) {
    return (
      <div className="diff-empty" data-testid="diff-empty">
        <p>No changes in this diff</p>
      </div>
    );
  }

  return (
    <CodeView<AnnotationMeta>
      ref={codeView}
      className="diff-scroll"
      items={items}
      selectedLines={selectedLines ?? null}
      options={{
        diffStyle,
        stickyHeaders: true,
        expansionLineCount: 20,
        // The library's own gutter "+" carries the GitHub gesture: a click
        // selects that line, a drag from it selects a range, and both land
        // in onGutterUtilityClick; a custom-rendered button would lose the
        // drag. Dragging line numbers also selects a range and lands in
        // onLineSelectionEnd.
        enableGutterUtility: Boolean(onLineSelect),
        enableLineSelection: Boolean(onLineSelect),
        onGutterUtilityClick: onLineSelect
          ? (range, context) => onLineSelect(context.item.id, range)
          : undefined,
        onLineSelectionEnd: onLineSelect
          ? (range, context) => {
              if (range) onLineSelect(context.item.id, range);
            }
          : undefined,
        theme: { dark: "github-dark", light: "github-light" },
        themeType: theme,
      }}
      renderAnnotation={
        renderAnnotation
          ? (annotation, item) =>
              renderAnnotation(
                annotation as DiffLineAnnotation<AnnotationMeta>,
                item.id,
              )
          : undefined
      }
      renderHeaderMetadata={(item) => {
        const binary = binaryByPath.get(item.id);
        if (binary) {
          return (
            <span className="binary-note" data-testid={`binary-${item.id}`}>
              Binary file ({binary.status}) — no diff shown
            </span>
          );
        }
        if (
          item.type === "diff" &&
          item.fileDiff.isPartial &&
          onExpandContext
        ) {
          return (
            <button
              type="button"
              className="expand-context"
              title="Load full file contents from the round snapshot to expand hunk context"
              onClick={() => onExpandContext(item.id)}
            >
              Expand context
            </button>
          );
        }
        return null;
      }}
    />
  );
});
