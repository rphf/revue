import { useEffect, useMemo, useState } from "react";
import { parseDiffFromFile } from "@pierre/diffs";
import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
} from "@pierre/diffs";
import { CodeView, type CodeViewReactOptions } from "@pierre/diffs/react";
import { CircleAlertIcon, HistoryIcon } from "lucide-react";
import { api } from "../api";
import type { Theme } from "../theme";
import type { Thread as ThreadType } from "../types";
import { threadRev } from "@/lib/threads";
import { timeAgo } from "@/lib/time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { LAYOUT, THEMES, UNSAFE_CSS } from "./codeViewStyle";
import type { AnnotationMeta, DiffStyle } from "./DiffView";
import Thread from "./Thread";

export interface SnapshotDialogProps {
  thread: ThreadType;
  diffStyle: DiffStyle;
  theme: Theme;
  onChanged: () => void;
  onClose: () => void;
}

type SnapshotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; file: FileDiffMetadata | null; createdAt: string };

// An outdated thread, read against the code it was written on: the
// file as it was when the thread started, rebuilt as a diff from the
// thread's snapshot, with the thread at its origin line. Reply and
// resolve work as anywhere else.
export default function SnapshotDialog({
  thread,
  diffStyle,
  theme,
  onChanged,
  onClose,
}: SnapshotDialogProps) {
  const [snap, setSnap] = useState<SnapshotState>({ status: "loading" });

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
              rev: threadRev(thread),
              thread,
            },
          },
        ],
      } as CodeViewItem<AnnotationMeta>,
    ];
  }, [snap, thread]);

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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        data-testid="snapshot-dialog"
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <HistoryIcon className="size-4 text-renamed" />
            As it was when the thread started
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono">
              {thread.path}:{thread.line}
            </span>
            {snap.status === "ready" && ` · ${timeAgo(snap.createdAt)}`}
            {". The code has changed since; reply and resolve still work here."}
          </DialogDescription>
        </DialogHeader>
        {snap.status === "loading" ? (
          <div className="space-y-3 p-5" aria-busy="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : snap.status === "error" ? (
          <p className="flex items-center gap-2 p-5 text-sm text-destructive">
            <CircleAlertIcon className="size-4" />
            {snap.message}
          </p>
        ) : items.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            The snapshot holds no text for this file.
          </p>
        ) : (
          <CodeView<AnnotationMeta>
            className="diff-scroll"
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
      </DialogContent>
    </Dialog>
  );
}
