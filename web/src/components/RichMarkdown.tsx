import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { CircleAlertIcon, PlusIcon } from "lucide-react";
import {
  blockForLine,
  blockTarget,
  type BlockTarget,
  type RichDoc,
} from "@/lib/richDiff";
import {
  MIN_RICH_WIDTH,
  applyRichWidth,
  restoreRichWidth,
  saveRichWidth,
} from "@/lib/richWidth";
import { cn } from "@/lib/utils";
import type { AnnotationMeta } from "./DiffView";
import LoadingBlocks from "./LoadingBlocks";
import { RichNotesContext } from "./richNotes";

type Note = DiffLineAnnotation<AnnotationMeta>;

export interface RichMarkdownProps {
  doc: RichDoc;
  path: string;
  // Draws a thread or the pending comment on lines of the file, under
  // the block that holds its line.
  renderNote?: (note: Note) => ReactNode;
  // Starts a comment on the source lines of a block.
  onComment?: (target: BlockTarget) => void;
}

const KEY_STEP = 40;

// The right edge of the document, dragged to set its width. The
// document is centered, so the edge moves half of what the width does.
function WidthHandle() {
  const drag = useRef<{ x: number; width: number; moved: boolean } | null>(
    null,
  );
  const bounds = (handle: HTMLElement) => {
    const article = handle.parentElement;
    return {
      width: article?.getBoundingClientRect().width ?? 0,
      max: article?.parentElement?.clientWidth || Infinity,
    };
  };
  const clamp = (px: number, max: number) =>
    Math.max(MIN_RICH_WIDTH, Math.min(px, max));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      x: e.clientX,
      width: bounds(e.currentTarget).width,
      moved: false,
    };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const { x, width } = drag.current;
    drag.current.moved = true;
    applyRichWidth(
      clamp(width + 2 * (e.clientX - x), bounds(e.currentTarget).max),
    );
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // A click that dragged nothing keeps the width that was saved.
    const { moved } = drag.current;
    drag.current = null;
    if (moved) saveRichWidth(bounds(e.currentTarget).width);
  };
  const reset = () => {
    applyRichWidth(null);
    saveRichWidth(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const { width, max } = bounds(e.currentTarget);
    const next = clamp(
      width + (e.key === "ArrowRight" ? KEY_STEP : -KEY_STEP),
      max,
    );
    applyRichWidth(next);
    saveRichWidth(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Document width"
      title="Drag to resize, double-click to reset"
      tabIndex={0}
      className="rich-width-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  );
}

// The element that scrolls the document, through the shadow roots the
// diff list puts between them.
function scrollParent(el: Element): HTMLElement | null {
  let node: Node | null = el;
  while (node) {
    node =
      node.parentNode instanceof ShadowRoot
        ? node.parentNode.host
        : node.parentNode;
    if (
      node instanceof HTMLElement &&
      /auto|scroll/.test(getComputedStyle(node).overflowY)
    )
      return node;
  }
  return null;
}

// Keeps the block at the top of the view where it is when the document
// changes height: a comment form opens, a thread folds, the width
// moves. The diff list holds its scroll position on what comes after
// the document, so on its own it moves the text the reviewer is reading
// by the height that changed below it.
function useSteadyScroll(
  article: RefObject<HTMLElement | null>,
  ready: boolean,
) {
  useEffect(() => {
    const el = article.current;
    if (!ready || !el || typeof ResizeObserver === "undefined") return;
    const scroller = scrollParent(el);
    if (!scroller) return;
    let anchor: { row: Element; top: number } | null = null;
    const mark = () => {
      const edge = scroller.getBoundingClientRect().top;
      anchor = null;
      for (const row of el.querySelectorAll(":scope > .rich-row")) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > edge) {
          anchor = { row, top: rect.top };
          break;
        }
      }
    };
    const restore = () => {
      if (anchor?.row.isConnected) {
        const moved = anchor.row.getBoundingClientRect().top - anchor.top;
        if (Math.abs(moved) >= 1)
          scroller.scrollBy({ top: moved, behavior: "instant" });
      }
      mark();
    };
    mark();
    const observer = new ResizeObserver(restore);
    observer.observe(el);
    scroller.addEventListener("scroll", mark, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", mark);
    };
  }, [article, ready]);
}

function commentLabel({ line, startLine }: BlockTarget): string {
  return startLine === undefined
    ? `Comment on line ${line}`
    : `Comment on lines ${startLine}–${line}`;
}

// The rendered side of a markdown file: sanitized HTML per block, with
// the changed blocks marked in the diff colors. Each block takes
// comments on its source lines, and shows the threads on them.
export default function RichMarkdown({
  doc,
  path,
  renderNote,
  onComment,
}: RichMarkdownProps) {
  useLayoutEffect(restoreRichWidth, []);
  const article = useRef<HTMLElement>(null);
  useSteadyScroll(article, doc.status === "ready");
  const notes = useContext(RichNotesContext)
    ?.get(path)
    ?.filter((a) => a.lineNumber !== 0);

  if (doc.status === "loading") {
    return (
      <LoadingBlocks
        className="px-6 py-5"
        bars={["h-6 w-1/3", "h-4 w-11/12", "h-4 w-4/5", "h-4 w-2/3"]}
      />
    );
  }
  if (doc.status === "error") {
    return (
      <p
        className="flex items-center gap-2 px-6 py-4 font-sans text-sm text-destructive"
        role="alert"
      >
        <CircleAlertIcon className="size-4" />
        {doc.message}
      </p>
    );
  }

  // Notes on a line past the last block of their side close the
  // document, under its last block or alone in an empty one.
  const notesByBlock = new Map<number, Note[]>();
  for (const note of notes ?? []) {
    const at = blockForLine(doc.blocks, note.side, note.lineNumber);
    const index = at < 0 ? doc.blocks.length - 1 : at;
    notesByBlock.set(index, [...(notesByBlock.get(index) ?? []), note]);
  }
  const drawNotes = (index: number) =>
    notesByBlock.get(index)?.map((note) => (
      <div
        key={`${note.metadata?.kind}:${note.metadata?.threadId ?? ""}`}
        data-rich-note={`${note.side}:${note.lineNumber}`}
      >
        {renderNote?.(note)}
      </div>
    ));

  return (
    <article
      ref={article}
      className="markdown-doc"
      data-testid="rich-markdown"
      data-rich-path={path}
    >
      {doc.blocks.map((block, i) => {
        const target = onComment ? blockTarget(block) : null;
        return (
          <div key={i} className="rich-row">
            <div className="markdown">
              <div
                className={cn(
                  "rich-block",
                  block.item && "rich-item",
                  block.change === "added" && "rich-added",
                  block.change === "removed" && "rich-removed",
                )}
                data-change={block.change}
                dangerouslySetInnerHTML={{ __html: block.html }}
              />
            </div>
            {target && (
              <button
                type="button"
                className="rich-comment"
                aria-label={commentLabel(target)}
                title={commentLabel(target)}
                onClick={() => onComment?.(target)}
              >
                <PlusIcon />
              </button>
            )}
            {drawNotes(i)}
          </div>
        );
      })}
      {drawNotes(-1)}
      <WidthHandle />
    </article>
  );
}
