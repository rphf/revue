import { useEffect, useMemo, useRef, useState } from "react";
import { parseDiffFromFile } from "@pierre/diffs";
import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
} from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  HistoryIcon,
} from "lucide-react";
import { api } from "../api";
import type { Theme } from "../theme";
import type { Thread as ThreadType } from "../types";
import { threadRev } from "@/lib/threads";
import { timeAgo } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  LAYOUT,
  LINE_SCROLL_OFFSET,
  THEMES,
  UNSAFE_CSS,
} from "./codeViewStyle";
import type { AnnotationMeta, DiffStyle } from "./DiffView";
import { useStickyHeaderFix } from "./stickyHeaderFix";
import Thread from "./Thread";

export interface SnapshotViewProps {
  thread: ThreadType;
  // Where this thread sits among the threads the view can step
  // through, zero-based.
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  diffStyle: DiffStyle;
  theme: Theme;
  onChanged: () => void;
  onClose: () => void;
}

type SnapshotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; file: FileDiffMetadata | null; createdAt: string };

// Page shortcuts stay out of the way of anything that takes text.
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable]") !== null
  );
}

function NavButton({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

// An outdated thread, read against the code it was written on: the
// file as it was when the thread started, rebuilt as a diff from the
// thread's snapshot, with the thread at its origin line. It takes the
// place of the tree and the diff, so the threads panel stays at hand to
// pick another thread; the header steps through the outdated ones.
// Reply and resolve work as anywhere else.
export default function SnapshotView({
  thread,
  index,
  total,
  onPrev,
  onNext,
  diffStyle,
  theme,
  onChanged,
  onClose,
}: SnapshotViewProps) {
  const [snap, setSnap] = useState<SnapshotState>({ status: "loading" });
  const codeView = useRef<CodeViewHandle<AnnotationMeta, undefined>>(null);
  useStickyHeaderFix(codeView);

  useEffect(() => {
    let cancelled = false;
    api
      .getSnapshot(thread.id)
      .then((s) => {
        if (cancelled) return;
        const file = parseDiffFromFile(
          s.oldContent !== null
            ? { name: s.oldPath || s.path, contents: s.oldContent }
            : null,
          s.newContent !== null
            ? { name: s.path, contents: s.newContent }
            : null,
        );
        setSnap({ status: "ready", file, createdAt: s.createdAt });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setSnap({
            status: "error",
            message: e instanceof Error ? e.message : String(e),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [thread.id]);

  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < total - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "k" && hasPrev) onPrev();
      else if (e.key === "j" && hasNext) onNext();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPrev, hasNext, onPrev, onNext, onClose]);

  // CodeView re-renders an item only when its version changes, so a
  // reply or a resolve bumps it through the thread's fingerprint.
  const rev = threadRev(thread);
  const [revision, setRevision] = useState({ rev, version: 0 });
  if (revision.rev !== rev) setRevision({ rev, version: revision.version + 1 });
  const version = revision.version;

  // The single item keeps its file object across renders: the
  // virtualizer lays it out once and refuses a different object later.
  const items = useMemo<CodeViewItem<AnnotationMeta>[]>(() => {
    if (snap.status !== "ready" || snap.file === null) return [];
    return [
      {
        id: thread.path,
        type: "diff",
        fileDiff: snap.file,
        annotations: [
          {
            side: thread.side,
            lineNumber: thread.line,
            metadata: {
              kind: "thread",
              threadId: thread.id,
              rev,
              thread,
            },
          },
        ],
        version,
      } as CodeViewItem<AnnotationMeta>,
    ];
  }, [snap, thread, rev, version]);

  // Opens on the thread, not on the top of the file. The CodeView
  // takes its items in its own effect, so the jump waits a frame.
  const ready = items.length > 0;
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() =>
      codeView.current?.scrollTo({
        type: "line",
        id: thread.path,
        lineNumber: thread.line,
        side: thread.side,
        align: "start",
        offset: LINE_SCROLL_OFFSET,
        behavior: "instant",
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [ready, thread.path, thread.line, thread.side]);

  const options = useMemo<CodeViewReactOptions<AnnotationMeta, undefined>>(
    () => ({
      diffStyle,
      stickyHeaders: true,
      overflow: "wrap",
      expansionLineCount: 20,
      layout: { ...LAYOUT, paddingBottom: 24 },
      unsafeCSS: UNSAFE_CSS,
      theme: THEMES,
      themeType: theme,
    }),
    [diffStyle, theme],
  );

  return (
    <section
      className="flex h-full min-w-0 flex-col bg-background"
      aria-label="Thread snapshot"
      data-testid="snapshot-view"
    >
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-b px-3 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <ArrowLeftIcon />
              Back to diff
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Back to diff <Kbd>Esc</Kbd>
          </TooltipContent>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <HistoryIcon className="size-3.5 shrink-0 text-renamed" />
            <span className="truncate">As it was when the thread started</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            <span className="font-mono">
              {thread.path}:{thread.line}
            </span>
            {snap.status === "ready" && ` · ${timeAgo(snap.createdAt)}`}
            {" · The code has changed since; reply and resolve still work."}
          </p>
        </div>
        {total > 0 && (
          <div className="flex shrink-0 items-center gap-1">
            {index >= 0 && (
              <span
                className="px-1 text-xs text-muted-foreground tabular-nums"
                data-testid="snapshot-position"
              >
                {index + 1} of {total} outdated
              </span>
            )}
            <NavButton
              label="Previous outdated thread"
              shortcut="K"
              disabled={!hasPrev}
              onClick={onPrev}
            >
              <ChevronUpIcon />
            </NavButton>
            <NavButton
              label="Next outdated thread"
              shortcut="J"
              disabled={!hasNext}
              onClick={onNext}
            >
              <ChevronDownIcon />
            </NavButton>
          </div>
        )}
      </div>
      {snap.status === "loading" ? (
        <div className="space-y-3 p-4" aria-busy="true">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : snap.status === "error" ? (
        <p className="flex items-center gap-2 p-4 text-sm text-destructive">
          <CircleAlertIcon className="size-4" />
          {snap.message}
        </p>
      ) : items.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          The snapshot holds no text for this file.
        </p>
      ) : (
        <CodeView<AnnotationMeta>
          ref={codeView}
          className="diff-scroll min-h-0 flex-1"
          items={items}
          options={options}
          renderAnnotation={(annotation) => {
            const meta = (annotation as DiffLineAnnotation<AnnotationMeta>)
              .metadata;
            return meta?.kind === "thread" && meta.thread ? (
              <Thread thread={meta.thread} onChanged={onChanged} />
            ) : null;
          }}
        />
      )}
    </section>
  );
}
