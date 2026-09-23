import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { api } from "../api";
import { useEvents } from "../useEvents";
import type { Theme } from "../theme";
import type {
  DiffResponse,
  Side,
  Thread as ThreadType,
  ThreadPosition,
} from "../types";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { useDefaultLayout } from "react-resizable-panels";
import CommentForm from "../components/CommentForm";
import ConnectionBanner from "../components/ConnectionBanner";
import { splitPatch, useFullDiffs } from "../components/ContextExpand";
import DiffView, {
  type AnnotationMeta,
  type DiffStyle,
  type DiffViewHandle,
  type PendingComment,
} from "../components/DiffView";
import FileTree from "../components/FileTree";
import RichMarkdown from "../components/RichMarkdown";
import SendDialog from "../components/SendDialog";
import SnapshotView from "../components/SnapshotView";
import Thread from "../components/Thread";
import { FocusedThreadContext } from "../components/threadFocus";
import ThreadsPanel from "../components/ThreadsPanel";
import TopBar from "../components/TopBar";
import { useRichDocs } from "@/lib/richDiff";
import { threadRev } from "@/lib/threads";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";

export interface DiffPageProps {
  args: string[];
  theme: Theme;
  onToggleTheme: () => void;
  onNavigate: (to: string) => void;
}

// One fetch of the diff, tagged with the arguments it was requested
// for, so a page that switched diffs shows a skeleton rather than the
// previous diff, while a refresh of the same diff keeps the old one on
// screen until the new one lands.
interface DiffLoad {
  argsKey: string;
  diff: DiffResponse | null;
  files: FileDiffMetadata[] | null;
  error: string | null;
}

const DIFF_STYLE_KEY = "revue-diff-style";

function loadDiffStyle(): DiffStyle {
  try {
    if (localStorage.getItem(DIFF_STYLE_KEY) === "unified") return "unified";
  } catch {
    // Storage can be unavailable; split is the default either way.
  }
  return "split";
}

function saveDiffStyle(style: DiffStyle): void {
  try {
    localStorage.setItem(DIFF_STYLE_KEY, style);
  } catch {
    // Not remembering the choice is fine.
  }
}

// parseFiles parses the patch and hands back the previous metadata
// object for every file whose section did not change, so a refresh
// re-renders only the files that moved.
function parseFiles(
  patch: string,
  prev: { patch: string; files: FileDiffMetadata[] } | null,
): FileDiffMetadata[] {
  if (patch.trim() === "") return [];
  const parsed = parsePatchFiles(patch).flatMap((p) => p.files);
  if (prev === null) return parsed;
  const before = splitPatch(prev.patch);
  const after = splitPatch(patch);
  const byName = new Map(prev.files.map((f) => [f.name, f]));
  return parsed.map((f) => {
    const old = byName.get(f.name);
    return old && before.get(f.name) === after.get(f.name) ? old : f;
  });
}

export default function DiffPage({
  args,
  theme,
  onToggleTheme,
  onNavigate,
}: DiffPageProps) {
  const argsKey = useMemo(() => JSON.stringify(args), [args]);
  const [load, setLoad] = useState<DiffLoad | null>(null);
  const [fetchNonce, setFetchNonce] = useState(0);
  const [threads, setThreads] = useState<ThreadType[]>([]);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [snapshotId, setSnapshotId] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [pulse, setPulse] = useState(0);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(loadDiffStyle);
  useEffect(() => saveDiffStyle(diffStyle), [diffStyle]);
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string>();
  // Markdown files shown rendered instead of as source (GitHub's rich
  // diff); the choice is per path and survives refreshes.
  const [richPaths, setRichPaths] = useState<ReadonlySet<string>>(new Set());
  const toggleRich = useCallback((path: string) => {
    setRichPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Pane widths survive reloads. The threads pane sits outside the
  // tree and the diff, so a snapshot can cover both and leave the list
  // of threads beside it; it is conditional, so the layout with and
  // without it is stored separately.
  const outerLayout = useDefaultLayout({
    id: "revue-outer-panes",
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
    panelIds: showPanel ? ["main", "threads"] : ["main"],
  });
  const mainLayout = useDefaultLayout({
    id: "revue-main-panes",
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
    panelIds: ["tree", "diff"],
  });

  const loadThreads = useCallback(() => {
    api
      .listThreads()
      .then((r) => {
        setThreads(r.threads);
        setThreadsError(null);
      })
      .catch((e) => setThreadsError(String(e)));
  }, []);
  useEffect(loadThreads, [loadThreads]);

  // The diff on screen, refetched whenever the server says it moved.
  const shown = load?.argsKey === argsKey ? load : null;
  useEffect(() => {
    let cancelled = false;
    api
      .getDiff(args)
      .then((diff) => {
        if (cancelled) return;
        setLoad((prev) => {
          const same = prev?.argsKey === argsKey ? prev : null;
          const files = parseFiles(
            diff.patch,
            same?.diff && same.files
              ? { patch: same.diff.patch, files: same.files }
              : null,
          );
          return { argsKey, diff, files, error: null };
        });
      })
      .catch((e) => {
        if (!cancelled)
          setLoad({ argsKey, diff: null, files: null, error: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [args, argsKey, fetchNonce]);
  const diff = shown?.diff ?? null;
  const parsedFiles = shown?.files ?? null;
  const diffError = shown?.error ?? null;
  const version = diff?.version ?? null;

  // Live updates: thread events refetch the threads; a diff.changed
  // notice with a version other than the one on screen refetches the
  // diff. The notice also opens every stream, so a reconnect catches
  // up on anything missed.
  const connection = useEvents(args, (e) => {
    if (e.type === "diff.changed") {
      const next = (e.payload as { version?: number } | null)?.version;
      if (next === undefined || next !== version) {
        setFetchNonce((n) => n + 1);
        setPulse((p) => p + 1);
      }
      return;
    }
    loadThreads();
  });

  const toggleViewed = useCallback((path: string) => {
    setViewed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const diffViewRef = useRef<DiffViewHandle>(null);
  const scrollToFile = useCallback((path: string) => {
    setSelectedPath(path);
    diffViewRef.current?.scrollToFile(path);
  }, []);

  const diffFiles = useMemo(() => diff?.files ?? [], [diff]);
  // Positions come with the diff. A thread the diff does not know yet
  // was started after that fetch, against this very diff, so it sits at
  // its origin until the next fetch says otherwise.
  const positions = useMemo(() => {
    const map = new Map<number, ThreadPosition>(
      (diff?.anchors ?? []).map((a) => [a.threadId, a]),
    );
    for (const t of threads) {
      if (!map.has(t.id)) {
        map.set(t.id, {
          threadId: t.id,
          path: t.path,
          side: t.side,
          line: t.line,
          startLine: t.startLine,
          state: "live",
        });
      }
    }
    return map;
  }, [diff, threads]);
  // Expansion and the rich view read the current capture.
  const { files: displayFiles, requestUpgrade } = useFullDiffs(
    args,
    version,
    parsedFiles,
    diffFiles,
    diff?.patch ?? null,
  );
  const richByFile = useRichDocs(args, version, richPaths);

  const draftCount = useMemo(
    () => threads.flatMap((t) => t.comments).filter((c) => c.draft).length,
    [threads],
  );

  // The text of the pending comment lives outside React state, so a
  // diff refresh that remounts its file restores it without a page
  // re-render per keystroke.
  const pendingBody = useRef("");

  // Inline annotations: every thread live in this diff, plus the single
  // pending comment form. Each annotation's metadata carries what
  // rendering it needs, and DiffView compares annotation content per
  // file, so a thread reload re-renders only the files whose
  // annotations actually changed.
  const annotationsByFile = useMemo(() => {
    const next = new Map<string, DiffLineAnnotation<AnnotationMeta>[]>();
    const push = (path: string, a: DiffLineAnnotation<AnnotationMeta>) => {
      const list = next.get(path) ?? [];
      list.push(a);
      next.set(path, list);
    };
    for (const t of threads) {
      const pos = positions.get(t.id);
      if (pos?.state !== "live") continue;
      push(pos.path, {
        side: pos.side,
        lineNumber: pos.line,
        metadata: {
          kind: "thread",
          threadId: t.id,
          rev: threadRev(t),
          thread: t,
        },
      });
    }
    if (pending) {
      push(pending.path, {
        side: pending.side,
        lineNumber: pending.line,
        metadata: {
          kind: "pending",
          rev: String(pending.startLine ?? ""),
          pending,
        },
      });
    }
    return next;
  }, [threads, positions, pending]);

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationMeta>) => {
      const meta = annotation.metadata;
      if (meta?.kind === "pending" && meta.pending) {
        const p = meta.pending;
        return (
          <div className="annotation-card p-2.5">
            <CommentForm
              initial={pendingBody.current}
              onChange={(body) => {
                pendingBody.current = body;
              }}
              placeholder={
                p.startLine && p.startLine !== p.line
                  ? `Comment on lines ${p.startLine}–${p.line}`
                  : `Comment on line ${p.line}`
              }
              submitLabel="Start thread"
              onSubmit={async (body) => {
                await api.createThread({
                  args,
                  path: p.path,
                  side: p.side,
                  line: p.line,
                  startLine: p.startLine,
                  body,
                });
                pendingBody.current = "";
                setPending(null);
                diffViewRef.current?.clearSelection();
                loadThreads();
                setFetchNonce((n) => n + 1);
              }}
              onCancel={() => {
                pendingBody.current = "";
                setPending(null);
                diffViewRef.current?.clearSelection();
              }}
            />
          </div>
        );
      }
      if (meta?.kind === "rich" && meta.rich) {
        return <RichMarkdown doc={meta.rich} />;
      }
      if (meta?.kind === "thread" && meta.thread) {
        return <Thread thread={meta.thread} onChanged={loadThreads} />;
      }
      return null;
    },
    [args, loadThreads],
  );

  const onLineSelect = useCallback((path: string, range: SelectedLineRange) => {
    const side = (range.endSide ?? range.side ?? "additions") as Side;
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    pendingBody.current = "";
    setPending({
      path,
      side,
      line: end,
      startLine: start !== end ? start : undefined,
    });
  }, []);

  // A pending form stays where it was started; when its file leaves
  // the diff it waits, text and all, for the file to come back.
  const pendingHidden =
    pending !== null &&
    parsedFiles !== null &&
    !parsedFiles.some((f) => f.name === pending.path);

  // A live thread scrolls to its line; an outdated one opens on the
  // file as it was when the thread started. Either way the thread is
  // outlined until the next click elsewhere.
  const jumpToThread = useCallback(
    (thread: ThreadType, position: ThreadPosition | undefined) => {
      setFocusedId(thread.id);
      if (position?.state === "live") {
        setSnapshotId(null);
        setSelectedPath(position.path);
        diffViewRef.current?.scrollToLine(
          position.path,
          position.side,
          position.line,
        );
      } else {
        setSnapshotId(thread.id);
      }
    },
    [],
  );
  const openSnapshot = useCallback((id: number) => {
    setSnapshotId(id);
    setFocusedId(id);
  }, []);
  const closeSnapshot = useCallback(() => setSnapshotId(null), []);

  useEffect(() => {
    if (focusedId === null) return;
    const onPointerDown = (e: PointerEvent) => {
      const inside = e
        .composedPath()
        .some(
          (n) =>
            n instanceof HTMLElement &&
            n.dataset.threadId === String(focusedId),
        );
      if (!inside) setFocusedId(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [focusedId]);

  // The snapshot steps through the threads that open there, in panel
  // order; the one on screen stays in the list even if its code came
  // back meanwhile.
  const outdated = useMemo(
    () =>
      threads.filter(
        (t) => positions.get(t.id)?.state !== "live" || t.id === snapshotId,
      ),
    [threads, positions, snapshotId],
  );
  const snapshotIndex = outdated.findIndex((t) => t.id === snapshotId);
  const snapshotThread = snapshotIndex >= 0 ? outdated[snapshotIndex] : null;

  const sendComments = useCallback(
    async (note: string) => {
      await api.send(note);
      setShowSend(false);
      loadThreads();
    },
    [loadThreads],
  );

  return (
    <TooltipProvider>
      <FocusedThreadContext.Provider value={focusedId}>
        <div className="flex h-full flex-col">
          <ConnectionBanner state={connection} />
          <TopBar
            branch={diff?.branch}
            args={args}
            onNavigate={onNavigate}
            pulse={pulse}
            threadCount={threads.length}
            panelOpen={showPanel}
            onTogglePanel={() => setShowPanel((v) => !v)}
            draftCount={draftCount}
            onSend={() => setShowSend(true)}
            diffStyle={diffStyle}
            onDiffStyleChange={setDiffStyle}
            theme={theme}
            onToggleTheme={onToggleTheme}
          />
          {threadsError && (
            <p
              className="flex items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
              role="alert"
            >
              <CircleAlertIcon className="size-3.5" />
              {threadsError}
            </p>
          )}
          {pendingHidden && pending && (
            <p
              className="flex items-center gap-2 border-b bg-renamed/10 px-3 py-1.5 text-xs text-renamed"
              role="status"
            >
              <CircleAlertIcon className="size-3.5" />
              <span>
                Your unsent comment on{" "}
                <span className="font-mono">
                  {pending.path}:{pending.line}
                </span>{" "}
                is kept until that file is back in the diff.
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() => {
                  pendingBody.current = "";
                  setPending(null);
                }}
              >
                <XIcon />
                Discard
              </Button>
            </p>
          )}
          <ResizablePanelGroup
            orientation="horizontal"
            id="outer-panes"
            className="min-h-0 flex-1"
            defaultLayout={outerLayout.defaultLayout}
            onLayoutChanged={outerLayout.onLayoutChanged}
          >
            <ResizablePanel
              id="main"
              minSize={560}
              className="relative min-w-0"
            >
              <ResizablePanelGroup
                orientation="horizontal"
                id="main-panes"
                defaultLayout={mainLayout.defaultLayout}
                onLayoutChanged={mainLayout.onLayoutChanged}
              >
                <ResizablePanel
                  id="tree"
                  defaultSize={272}
                  minSize={200}
                  maxSize="40"
                  className="flex min-w-0 flex-col bg-sidebar text-sidebar-foreground"
                >
                  <FileTree
                    files={diffFiles}
                    viewed={viewed}
                    onToggleViewed={toggleViewed}
                    onSelect={scrollToFile}
                    selectedPath={selectedPath}
                  />
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel
                  id="diff"
                  minSize={360}
                  className="flex min-w-0 flex-col"
                >
                  {diffError !== null ? (
                    <div
                      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
                      data-testid="diff-error"
                    >
                      <CircleAlertIcon className="size-6 text-destructive" />
                      <p className="max-w-lg text-destructive">{diffError}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setFetchNonce((n) => n + 1)}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : displayFiles === null ? (
                    <div
                      className="flex-1 space-y-3 p-4"
                      data-testid="diff-loading"
                      aria-busy="true"
                    >
                      <span className="sr-only">Loading diff…</span>
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-4 w-4/5" />
                      <Skeleton className="mt-6 h-9 w-full" />
                      <Skeleton className="h-4 w-1/2" />
                      <Skeleton className="h-4 w-3/5" />
                    </div>
                  ) : (
                    <DiffView
                      ref={diffViewRef}
                      files={displayFiles}
                      diffFiles={diffFiles}
                      diffStyle={diffStyle}
                      theme={theme}
                      annotationsByFile={annotationsByFile}
                      renderAnnotation={renderAnnotation}
                      onLineSelect={onLineSelect}
                      onExpandContext={requestUpgrade}
                      richByFile={richByFile}
                      onToggleRich={toggleRich}
                    />
                  )}
                </ResizablePanel>
              </ResizablePanelGroup>
              {snapshotThread && (
                <div className="absolute inset-0 z-10">
                  <SnapshotView
                    key={snapshotThread.id}
                    thread={snapshotThread}
                    index={snapshotIndex}
                    total={outdated.length}
                    onPrev={() => openSnapshot(outdated[snapshotIndex - 1].id)}
                    onNext={() => openSnapshot(outdated[snapshotIndex + 1].id)}
                    diffStyle={diffStyle}
                    theme={theme}
                    onChanged={loadThreads}
                    onClose={closeSnapshot}
                  />
                </div>
              )}
            </ResizablePanel>
            {showPanel && (
              <>
                <ResizableHandle />
                <ResizablePanel
                  id="threads"
                  defaultSize={360}
                  minSize={280}
                  maxSize="45"
                  className="flex min-w-0 flex-col bg-sidebar text-sidebar-foreground"
                >
                  <ThreadsPanel
                    threads={threads}
                    positions={positions}
                    onJump={jumpToThread}
                    activeId={snapshotThread?.id ?? focusedId}
                    onClose={() => setShowPanel(false)}
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
          {showSend && (
            <SendDialog
              draftCount={draftCount}
              onSend={sendComments}
              onClose={() => setShowSend(false)}
            />
          )}
        </div>
      </FocusedThreadContext.Provider>
    </TooltipProvider>
  );
}
