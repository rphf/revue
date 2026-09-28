import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileContents,
  FileDiffLoadedFiles,
  FileDiffMetadata,
  LineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import {
  BookOpenTextIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  FileDiffIcon,
  MessageSquarePlusIcon,
} from "lucide-react";
import type { DiffFile, Side, Thread } from "../types";
import type { Theme } from "../theme";
import { binarySummary, isImagePath } from "@/lib/binary";
import { isMarkdownPath, type RichDoc } from "@/lib/richDiff";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { BASE_OPTIONS, LINE_SCROLL_OFFSET } from "./codeViewStyle";
import ImageDiff, { type ImageDiffProps } from "./ImageDiff";
import { useScrollMemory } from "./scrollMemory";
import { useStickyHeaderFix } from "./stickyHeaderFix";
import { treePathCompare } from "./treePath";

export type DiffStyle = "unified" | "split";

// Metadata attached to each annotation; U6 renders threads and
// pending comment forms through it. rev fingerprints the thread's
// visible content so item versions bump only when something changed.
// An outdated thread sits at line 0, under its file's header.
export interface AnnotationMeta {
  kind: "thread" | "outdated" | "pending" | "rich" | "image";
  threadId?: number;
  rev?: string;
  thread?: Thread;
  pending?: PendingComment;
  rich?: RichDoc;
  image?: Omit<ImageDiffProps, "diffStyle">;
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
  // Both versions of a changed file, fetched on the first click that
  // expands hunk context in it.
  loadFile?: (path: string) => Promise<FileDiffLoadedFiles>;
  // Markdown files switched to the rendered view, with their documents.
  richByFile?: ReadonlyMap<string, RichDoc>;
  onToggleRich?: (path: string) => void;
  // Where to load one side of an image file in this diff.
  imageUrl?: (path: string, side: "old" | "new") => string;
  viewed?: ReadonlySet<string>;
  onToggleViewed?: (path: string) => void;
  // Starts a comment on the file as a whole, from its header.
  onFileComment?: (path: string) => void;
  // Files shown as their header only.
  collapsed?: ReadonlySet<string>;
  onToggleCollapsed?: (path: string) => void;
  // Names the diff whose scroll position survives a reload.
  scrollKey?: string;
}

interface ItemMemo {
  fileDiff: FileDiffMetadata;
  annotations?: DiffLineAnnotation<AnnotationMeta>[];
  rich: boolean;
  // The rich variant's file object, kept across renders: the virtualizer
  // lays an item out from this object and refuses a different one later.
  richFile?: FileContents;
  collapsed: boolean;
  version: number;
}

// A markdown file in rich view is a one-line file item whose file-level
// annotation carries the rendered document: the library renders that
// annotation only above a line, so the line is a short caption.
const RICH_CAPTION = "Switch to Source to comment on lines.";

// A binary file is a one-line file item too: the caption, with an image
// file's preview as the annotation above it.
const BINARY_CAPTION = "Binary file: no line diff.";

// A file with outdated threads but no change left in this diff is a
// one-line file item too, so its threads stay in the diff.
const GONE_CAPTION = "No change left in this file.";

interface BinaryMemo {
  file: FileContents;
  rev?: string;
  notes?: DiffLineAnnotation<AnnotationMeta>[];
  collapsed: boolean;
  version: number;
}

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
// in. Items render in tree order, binary files as one-line file items
// in place (R24), images previewed; an empty diff renders the empty
// state. Memoized: the page re-renders for reasons of its own (a
// thread refresh, the panel), and the list re-renders only on props.
const DiffView = forwardRef<DiffViewHandle, DiffViewProps>(function DiffView(
  {
    files,
    diffFiles,
    diffStyle,
    theme,
    annotationsByFile,
    renderAnnotation,
    onLineSelect,
    loadFile,
    richByFile,
    onToggleRich,
    imageUrl,
    viewed,
    onToggleViewed,
    onFileComment,
    collapsed,
    onToggleCollapsed,
    scrollKey,
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
      clearSelection: () => codeView.current?.clearSelectedLines(),
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
  const binaryMemoRef = useRef<Map<string, BinaryMemo>>(new Map());
  const goneMemoRef = useRef<Map<string, BinaryMemo>>(new Map());

  const gonePaths = useMemo(() => {
    const inDiff = new Set([
      ...files.map((f) => f.name),
      ...binaryByPath.keys(),
    ]);
    return new Set(
      [...(annotationsByFile?.entries() ?? [])]
        .filter(
          ([path, list]) =>
            !inDiff.has(path) &&
            list.some((a) => a.metadata?.kind === "outdated"),
        )
        .map(([path]) => path),
    );
  }, [files, binaryByPath, annotationsByFile]);

  const items = useMemo<CodeViewItem<AnnotationMeta>[]>(() => {
    const ordered = [
      ...files
        .filter((f) => !binaryByPath.has(f.name))
        .map((f) => ({ path: f.name, meta: f as FileDiffMetadata | null })),
      ...[...binaryByPath.keys(), ...gonePaths].map((path) => ({
        path,
        meta: null as FileDiffMetadata | null,
      })),
    ].sort((a, b) => treePathCompare(a.path, b.path));

    return ordered.map(({ path, meta }) => {
      const isCollapsed = collapsed?.has(path) ?? false;
      // Threads on the whole file sit at line 0, under the header, in
      // every variant of the item.
      const fileNotes = annotationsByFile
        ?.get(path)
        ?.filter((a) => a.lineNumber === 0);
      if (gonePaths.has(path)) {
        const notes = fileNotes?.filter((a) => a.metadata?.kind === "outdated");
        const prev = goneMemoRef.current.get(path);
        const memo: BinaryMemo = {
          file: prev?.file ?? {
            name: path,
            contents: GONE_CAPTION,
            lang: "text",
          },
          notes,
          collapsed: isCollapsed,
          version:
            prev === undefined
              ? 0
              : prev.collapsed === isCollapsed &&
                  annotationsEqual(prev.notes, notes)
                ? prev.version
                : prev.version + 1,
        };
        goneMemoRef.current.set(path, memo);
        return {
          id: path,
          type: "file",
          file: memo.file,
          annotations: notes?.map(({ lineNumber, metadata }) => ({
            lineNumber,
            metadata,
          })),
          collapsed: isCollapsed,
          version: memo.version,
        } as CodeViewItem<AnnotationMeta>;
      }
      if (meta === null) {
        const binary = binaryByPath.get(path);
        const image =
          binary && imageUrl && isImagePath(path)
            ? {
                path,
                status: binary.status,
                oldUrl:
                  binary.oldSize !== undefined
                    ? imageUrl(path, "old")
                    : undefined,
                newUrl:
                  binary.newSize !== undefined
                    ? imageUrl(path, "new")
                    : undefined,
                oldSize: binary.oldSize,
                newSize: binary.newSize,
              }
            : undefined;
        const rev = image && `${image.oldUrl}|${image.newUrl}`;
        const prev = binaryMemoRef.current.get(path);
        const memo: BinaryMemo = prev
          ? {
              ...prev,
              rev,
              notes: fileNotes,
              collapsed: isCollapsed,
              version:
                prev.rev === rev &&
                prev.collapsed === isCollapsed &&
                annotationsEqual(prev.notes, fileNotes)
                  ? prev.version
                  : prev.version + 1,
            }
          : {
              file: { name: path, contents: BINARY_CAPTION, lang: "text" },
              rev,
              notes: fileNotes,
              collapsed: isCollapsed,
              version: 0,
            };
        binaryMemoRef.current.set(path, memo);
        const fileAnnotations = [
          ...(image
            ? [{ lineNumber: 0, metadata: { kind: "image", rev, image } }]
            : []),
          ...(fileNotes ?? []).map(({ lineNumber, metadata }) => ({
            lineNumber,
            metadata,
          })),
        ];
        return {
          id: path,
          type: "file",
          file: memo.file,
          annotations: fileAnnotations.length > 0 ? fileAnnotations : undefined,
          collapsed: isCollapsed,
          version: memo.version,
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
            ...(fileNotes ?? []),
          ]
        : annotationsByFile?.get(path);
      const prev = memoRef.current.get(path);
      let version = prev?.version ?? 0;
      if (
        prev &&
        (prev.fileDiff !== meta ||
          prev.rich !== Boolean(richDoc) ||
          prev.collapsed !== isCollapsed ||
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
        collapsed: isCollapsed,
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
          collapsed: isCollapsed,
          version,
        } as CodeViewItem<AnnotationMeta>;
      }
      return {
        id: path,
        type: "diff",
        fileDiff: meta,
        annotations,
        collapsed: isCollapsed,
        version,
      } as CodeViewItem<AnnotationMeta>;
    });
  }, [
    files,
    binaryByPath,
    gonePaths,
    annotationsByFile,
    richByFile,
    imageUrl,
    collapsed,
  ]);

  // The options object is stable across renders that do not change it,
  // as the library asks; a new object would re-configure the viewer.
  const options = useMemo<CodeViewReactOptions<AnnotationMeta, undefined>>(
    () => ({
      ...BASE_OPTIONS,
      diffStyle,
      loadDiffFiles: loadFile && ((fileDiff) => loadFile(fileDiff.name)),
      // The library's own gutter "+" carries the GitHub gesture: a click
      // selects that line, a drag from it selects a range, and both land
      // in onGutterUtilityClick; a custom-rendered button would lose the
      // drag. Dragging line numbers also selects a range and lands in
      // onLineSelectionEnd.
      enableGutterUtility: Boolean(onLineSelect),
      enableLineSelection: Boolean(onLineSelect),
      // Only diff items take comments: the rich view and binary files
      // are one-line file items with a caption.
      onGutterUtilityClick: onLineSelect
        ? (range, context) => {
            if (context.item.type === "diff")
              onLineSelect(context.item.id, range);
          }
        : undefined,
      onLineSelectionEnd: onLineSelect
        ? (range, context) => {
            if (range && context.item.type === "diff")
              onLineSelect(context.item.id, range);
          }
        : undefined,
      themeType: theme,
    }),
    [diffStyle, theme, onLineSelect, loadFile],
  );

  // The render callbacks change only with what they draw, so the
  // library re-renders its slots when the viewed or collapsed state
  // moves, and not on every render of the page.
  const renderItemAnnotation = useCallback(
    (
      annotation:
        DiffLineAnnotation<AnnotationMeta> | LineAnnotation<AnnotationMeta>,
      item: CodeViewItem<AnnotationMeta>,
    ) => {
      const meta = annotation.metadata as AnnotationMeta | undefined;
      if (meta?.kind === "image" && meta.image) {
        return <ImageDiff {...meta.image} diffStyle={diffStyle} />;
      }
      return renderAnnotation?.(
        annotation as DiffLineAnnotation<AnnotationMeta>,
        pathFromItemId(item.id),
      );
    },
    [diffStyle, renderAnnotation],
  );

  const renderHeaderPrefix = useMemo(
    () =>
      onToggleCollapsed &&
      ((item: CodeViewItem<AnnotationMeta>) => {
        const path = pathFromItemId(item.id);
        const isCollapsed = collapsed?.has(path) ?? false;
        return (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-ml-1 text-muted-foreground hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted aria-expanded:hover:text-foreground"
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${path}`}
            aria-expanded={!isCollapsed}
            onClick={() => onToggleCollapsed(path)}
          >
            {isCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
          </Button>
        );
      }),
    [collapsed, onToggleCollapsed],
  );

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<AnnotationMeta>) => {
      const path = pathFromItemId(item.id);
      if (gonePaths.has(path)) {
        return (
          <span
            className="font-sans text-xs text-muted-foreground"
            data-testid={`gone-${path}`}
          >
            Not in this diff any more
          </span>
        );
      }
      const commentButton = onFileComment && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label={`Comment on ${path}`}
          title="Comment on this file"
          onClick={() => onFileComment(path)}
        >
          <MessageSquarePlusIcon />
        </Button>
      );
      const viewedToggle = onToggleViewed && (
        <label className="flex h-6 cursor-pointer items-center gap-1.5 rounded-[min(var(--radius-md),10px)] px-2 font-sans text-xs font-medium text-muted-foreground transition-colors select-none hover:bg-muted hover:text-foreground has-data-checked:text-foreground dark:hover:bg-muted/50">
          <Checkbox
            className="size-3.5 [&_svg]:size-3!"
            checked={viewed?.has(path) ?? false}
            onCheckedChange={() => onToggleViewed(path)}
            aria-label={`Viewed ${path}`}
          />
          Viewed
        </label>
      );
      const binary = binaryByPath.get(path);
      if (binary) {
        return (
          <span className="flex items-center gap-1 font-sans">
            <span
              className="text-xs text-muted-foreground"
              data-testid={`binary-${path}`}
            >
              {binarySummary(binary.oldSize, binary.newSize) ||
                `Binary file (${binary.status})`}
            </span>
            {commentButton}
            {viewedToggle}
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
          {commentButton}
          {viewedToggle}
        </span>
      );
    },
    [
      viewed,
      onToggleViewed,
      onFileComment,
      binaryByPath,
      gonePaths,
      richByFile,
      onToggleRich,
    ],
  );

  const onScroll = useScrollMemory(codeView, scrollKey, items.length > 0);

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

  // Only files kept for their outdated threads: the diff itself is
  // empty, and says so above them.
  const onlyGone = items.length === gonePaths.size;
  return (
    <>
      {onlyGone && (
        <p
          className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm text-muted-foreground"
          data-testid="diff-empty"
        >
          <FileDiffIcon className="size-4 opacity-60" />
          No changes in this diff. The threads below are on code that changed
          since they started.
        </p>
      )}
      <CodeView<AnnotationMeta>
        ref={codeView}
        className="diff-scroll"
        items={items}
        options={options}
        onScroll={onScroll}
        renderAnnotation={renderItemAnnotation}
        renderHeaderPrefix={renderHeaderPrefix}
        renderHeaderMetadata={renderHeaderMetadata}
      />
    </>
  );
});

export default memo(DiffView);
