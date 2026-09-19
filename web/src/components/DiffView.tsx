import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import { FileDiffIcon, UnfoldVerticalIcon } from "lucide-react";
import type { ReviewState, RoundFile, Side, Thread } from "../types";
import type { Theme } from "../theme";
import { Button } from "@/components/ui/button";
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
  // Drops the line selection the library keeps after a gutter click or
  // drag, so the next one starts fresh instead of extending it.
  clearSelection(): void;
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
  onExpandContext?: (path: string) => void;
}

interface ItemMemo {
  fileDiff: FileDiffMetadata;
  annotations?: DiffLineAnnotation<AnnotationMeta>[];
  version: number;
}

// GitHub's own Shiki themes for the code; the surrounding chrome is
// the app palette. The -default variants are GitHub's current colors
// and their backgrounds sit next to the neutral page without a seam.
const THEMES = { light: "github-light-default", dark: "github-dark-default" };

// Item spacing lives in the CodeView layout, not in CSS, so the
// virtualizer's offsets and the painted gaps agree. The bottom padding
// lets the last file scroll to the top of the pane.
const LAYOUT = { paddingTop: 12, paddingBottom: 480, gap: 16 };

// Each file renders in its own shadow root; this is the one way to give
// it a card outline. The app's border token inherits through the
// shadow boundary. No overflow clipping, or the sticky header stops
// sticking.
const UNSAFE_CSS = `
:host { border: 1px solid var(--border); border-radius: var(--radius-lg); }
[data-diffs-header] { border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
[data-diff], [data-file] { border-radius: 0 0 var(--radius-lg) var(--radius-lg); }
`;

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
      clearSelection: () => {
        codeView.current?.getInstance()?.setSelectedLines(null);
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

  // The options object is stable across renders that do not change it,
  // as the library asks; a new object would re-configure the viewer.
  const options = useMemo<CodeViewReactOptions<AnnotationMeta, undefined>>(
    () => ({
      diffStyle,
      stickyHeaders: true,
      // Long lines soft-wrap inside their column instead of clipping
      // behind a horizontal scrollbar; prose and 80-column docs read
      // whole in split view.
      overflow: "wrap",
      expansionLineCount: 20,
      layout: LAYOUT,
      unsafeCSS: UNSAFE_CSS,
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
      theme: THEMES,
      themeType: theme,
    }),
    [diffStyle, theme, onLineSelect],
  );

  if (items.length === 0) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground"
        data-testid="diff-empty"
      >
        <FileDiffIcon className="size-6 opacity-60" />
        <p>No changes in this diff</p>
      </div>
    );
  }

  return (
    <CodeView<AnnotationMeta>
      ref={codeView}
      className="diff-scroll"
      items={items}
      options={options}
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
            <span
              className="font-sans text-xs text-muted-foreground"
              data-testid={`binary-${item.id}`}
            >
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
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="font-sans text-muted-foreground hover:text-foreground"
              title="Load full file contents from the round snapshot to expand hunk context"
              onClick={() => onExpandContext(item.id)}
            >
              <UnfoldVerticalIcon />
              Expand context
            </Button>
          );
        }
        return null;
      }}
    />
  );
});
