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
  FileContents,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import {
  BookOpenTextIcon,
  CodeIcon,
  FileDiffIcon,
  UnfoldVerticalIcon,
} from "lucide-react";
import type { DiffFile, Side, Thread } from "../types";
import type { Theme } from "../theme";
import { isMarkdownPath, type RichDoc } from "@/lib/richDiff";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  LAYOUT,
  LINE_SCROLL_OFFSET,
  THEMES,
  UNSAFE_CSS,
} from "./codeViewStyle";
import { useStickyHeaderFix } from "./stickyHeaderFix";
import { treePathCompare } from "./treePath";

export type DiffStyle = "unified" | "split";

// Metadata attached to each annotation; U6 renders threads and
// pending comment forms through it. rev fingerprints the thread's
// visible content so item versions bump only when something changed.
export interface AnnotationMeta {
  kind: "thread" | "pending" | "rich";
  threadId?: number;
  rev?: string;
  thread?: Thread;
  pending?: PendingComment;
  rich?: RichDoc;
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
  // Brings a line near the top, with a few lines above it, so the
  // thread drawn under it is in view. A line the diff does not show
  // leaves the view at the top of its file.
  scrollToLine(path: string, side: Side, line: number): void;
  // Drops the line selection the library keeps after a gutter click or
  // drag, so the next one starts fresh instead of extending it.
  clearSelection(): void;
}

export interface DiffViewProps {
  files: FileDiffMetadata[];
  diffFiles: DiffFile[];
  diffStyle: DiffStyle;
  theme: Theme;
  annotationsByFile?: Map<string, DiffLineAnnotation<AnnotationMeta>[]>;
  renderAnnotation?: (
    annotation: DiffLineAnnotation<AnnotationMeta>,
    path: string,
  ) => ReactNode;
  onLineSelect?: (path: string, range: SelectedLineRange) => void;
  onExpandContext?: (path: string) => void;
  // Markdown files switched to the rendered view, with their documents.
  richByFile?: ReadonlyMap<string, RichDoc>;
  onToggleRich?: (path: string) => void;
}

interface ItemMemo {
  fileDiff: FileDiffMetadata;
  annotations?: DiffLineAnnotation<AnnotationMeta>[];
  rich: boolean;
  // The rich variant's file object, kept across renders: the virtualizer
  // lays an item out from this object and refuses a different one later.
  richFile?: FileContents;
  version: number;
}

// A markdown file in rich view is a one-line file item whose file-level
// annotation carries the rendered document: the library renders that
// annotation only above a line, so the line is a short caption.
const RICH_CAPTION = "Switch to Source to comment on lines.";

// The rich variant is a separate item: the virtualizer prepares a layout
// per item id and refuses to render a file where it laid out a diff.
const RICH_PREFIX = "rich:";
const richItemId = (path: string) => RICH_PREFIX + path;
const isRichItemId = (id: string) => id.startsWith(RICH_PREFIX);
const pathFromItemId = (id: string) =>
  isRichItemId(id) ? id.slice(RICH_PREFIX.length) : id;

// The whole diff pane is ONE CodeView (the diffs.com architecture):
// every file is an item in a single virtualized list whose layout is
// computed from line counts up front — no per-file mounting or height
// measuring — and rows paint as plain text while highlighting streams
// in. Items render in tree order, binary files as stat-only header
// items in place (R24); an empty diff renders the empty state.
export default forwardRef<DiffViewHandle, DiffViewProps>(function DiffView(
  {
    files,
    diffFiles,
    diffStyle,
    theme,
    annotationsByFile,
    renderAnnotation,
    onLineSelect,
    onExpandContext,
    richByFile,
    onToggleRich,
  }: DiffViewProps,
  ref,
) {
  const codeView = useRef<CodeViewHandle<AnnotationMeta, undefined>>(null);
  useStickyHeaderFix(codeView);
  const richRef = useRef(richByFile);
  richRef.current = richByFile;
  useImperativeHandle(
    ref,
    () => ({
      scrollToFile: (path: string) => {
        codeView.current?.scrollTo({
          type: "item",
          id: richRef.current?.has(path) ? richItemId(path) : path,
          align: "start",
          behavior: "instant",
        });
      },
      scrollToLine: (path: string, side: Side, line: number) => {
        const id = richRef.current?.has(path) ? richItemId(path) : path;
        codeView.current?.scrollTo({
          type: "item",
          id,
          align: "start",
          behavior: "instant",
        });
        codeView.current?.scrollTo({
          type: "line",
          id,
          lineNumber: line,
          side,
          align: "start",
          offset: LINE_SCROLL_OFFSET,
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
    () => new Map(diffFiles.filter((f) => f.isBinary).map((f) => [f.path, f])),
    [diffFiles],
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
      const richDoc = richByFile?.get(path);
      const annotations = richDoc
        ? [
            {
              side: "additions" as const,
              lineNumber: 0,
              metadata: {
                kind: "rich" as const,
                rev: richDoc.rev,
                rich: richDoc,
              },
            },
          ]
        : annotationsByFile?.get(path);
      const prev = memoRef.current.get(path);
      let version = prev?.version ?? 0;
      if (
        prev &&
        (prev.fileDiff !== meta ||
          prev.rich !== Boolean(richDoc) ||
          !annotationsEqual(prev.annotations, annotations))
      )
        version++;
      const richFile = richDoc
        ? (prev?.richFile ?? {
            name: path,
            contents: RICH_CAPTION,
            lang: "text",
          })
        : undefined;
      memoRef.current.set(path, {
        fileDiff: meta,
        annotations,
        rich: Boolean(richDoc),
        richFile,
        version,
      });
      if (richDoc && richFile) {
        return {
          id: richItemId(path),
          type: "file",
          file: richFile,
          annotations: annotations?.map(({ lineNumber, metadata }) => ({
            lineNumber,
            metadata,
          })),
          version,
        } as CodeViewItem<AnnotationMeta>;
      }
      return {
        id: path,
        type: "diff",
        fileDiff: meta,
        annotations,
        version,
      } as CodeViewItem<AnnotationMeta>;
    });
  }, [files, binaryByPath, annotationsByFile, richByFile]);

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
        ? (range, context) => {
            if (!isRichItemId(context.item.id))
              onLineSelect(context.item.id, range);
          }
        : undefined,
      onLineSelectionEnd: onLineSelect
        ? (range, context) => {
            if (range && !isRichItemId(context.item.id))
              onLineSelect(context.item.id, range);
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
                pathFromItemId(item.id),
              )
          : undefined
      }
      renderHeaderMetadata={(item) => {
        const path = pathFromItemId(item.id);
        const binary = binaryByPath.get(path);
        if (binary) {
          return (
            <span
              className="font-sans text-xs text-muted-foreground"
              data-testid={`binary-${path}`}
            >
              Binary file ({binary.status}) — no diff shown
            </span>
          );
        }
        const rich = richByFile?.has(path) ?? false;
        return (
          <span className="flex items-center gap-1 font-sans">
            {isMarkdownPath(path) && onToggleRich && (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={rich ? "rich" : "source"}
                onValueChange={(v) => {
                  if (v && (v === "rich") !== rich) onToggleRich(path);
                }}
                aria-label="Markdown view"
              >
                <ToggleGroupItem
                  value="source"
                  aria-label="Source"
                  title="Source"
                >
                  <CodeIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="rich" aria-label="Rich" title="Rich">
                  <BookOpenTextIcon />
                </ToggleGroupItem>
              </ToggleGroup>
            )}
            {item.type === "diff" &&
              item.fileDiff.isPartial &&
              onExpandContext && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground hover:text-foreground"
                  title="Load the full file to expand hunk context"
                  onClick={() => onExpandContext(item.id)}
                >
                  <UnfoldVerticalIcon />
                  Expand context
                </Button>
              )}
          </span>
        );
      }}
    />
  );
});
