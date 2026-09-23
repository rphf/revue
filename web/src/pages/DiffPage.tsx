import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { api, errorMessage } from "../api";
import { useEvents } from "../useEvents";
import type { Theme } from "../theme";
import type {
  DiffResponse,
  Send,
  Side,
  Thread as ThreadType,
  ThreadPosition,
} from "../types";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { useDefaultLayout } from "react-resizable-panels";
import CommentForm from "../components/CommentForm";
import ConnectionBanner from "../components/ConnectionBanner";
import DiffView, {
  type AnnotationMeta,
  type DiffStyle,
  type DiffViewHandle,
  type PendingComment,
} from "../components/DiffView";
import FileTree from "../components/FileTree";
import LoadingBlocks from "../components/LoadingBlocks";
import RichMarkdown from "../components/RichMarkdown";
import SendComposer from "../components/SendComposer";
import SnapshotView from "../components/SnapshotView";
import Thread from "../components/Thread";
import { FocusedThreadContext } from "../components/threadFocus";
import ThreadsPanel from "../components/ThreadsPanel";
import TopBar from "../components/TopBar";
import { keyForArgs } from "@/lib/diffArgs";
import { freshCacheKey, loadedFiles, splitPatch } from "@/lib/patch";
import { useRichDocs } from "@/lib/richDiff";
import { groupByRound } from "@/lib/rounds";
import { threadRev } from "@/lib/threads";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
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
// re-renders only the files that moved. Each parse gets a fresh cache
// key prefix; a kept file keeps its old key, and with it the worker
// pool's highlight.
function parseFiles(
  patch: string,
  prev: { patch: string; files: FileDiffMetadata[] } | null,
): FileDiffMetadata[] {
  if (patch.trim() === "") return [];
  const parsed = parsePatchFiles(patch, freshCacheKey("patch")).flatMap(
    (p) => p.files,
  );
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
  const argsKey = useMemo(() => keyForArgs(args), [args]);
  const [load, setLoad] = useState<DiffLoad | null>(null);
  const [fetchNonce, setFetchNonce] = useState(0);
  const [threads, setThreads] = useState<ThreadType[]>([]);
  const [sends, setSends] = useState<Send[]>([]);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const togglePanel = useCallback(() => setShowPanel((v) => !v), []);
  const closePanel = useCallback(() => setShowPanel(false), []);
  // The note for the next send outlives the panel, so closing it to
  // look at the diff loses nothing. The composer owns the text while it
  // is open and hands it back when it closes, so typing re-renders the
  // composer alone.
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [composerFocus, setComposerFocus] = useState(0);
  const [snapshotId, setSnapshotId] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [pulse, setPulse] = useState(0);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(loadDiffStyle);
  const changeDiffStyle = useCallback((style: DiffStyle) => {
    setDiffStyle(style);
    saveDiffStyle(style);
  }, []);
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

  // Threads and the sends that group them into rounds load together,
  // so a Send never shows its threads under the wrong round. Calls
  // coalesce: one fetch at a time, and any number of calls while it is
  // in flight make one more after it, so a burst of events (a replay on
  // connect, a send and its event) costs at most two fetches. Only the
  // latest request's answer lands; one overtaken by a later call is
  // dropped.
  const threadsLoad = useRef({ seq: 0, inFlight: false, again: false });
  const loadThreads = useCallback(() => {
    const state = threadsLoad.current;
    if (state.inFlight) {
      state.again = true;
      state.seq += 1;
      return;
    }
    const run = () => {
      state.inFlight = true;
      state.again = false;
      const seq = ++state.seq;
      Promise.all([api.listThreads(), api.listSends()])
        .then(
          ([t, s]) => {
            if (seq !== state.seq) return;
            setThreads(t.threads);
            setSends(s.sends);
            setThreadsError(null);
          },
          (e: unknown) => {
            if (seq === state.seq) setThreadsError(errorMessage(e));
          },
        )
        .finally(() => {
          state.inFlight = false;
          if (state.again) run();
        });
    };
    run();
  }, []);
  const rounds = useMemo(() => groupByRound(threads, sends), [threads, sends]);
  useEffect(loadThreads, [loadThreads]);

  // The diff on screen, refetched whenever the server says it moved.
  const shown = load?.argsKey === argsKey ? load : null;
  // The latest diff.changed notice. One that comes while the first
  // fetch for these arguments is in flight is answered when it lands.
  const notice = useRef<{ argsKey: string; version?: number } | null>(null);
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
        const seen = notice.current;
        if (
          seen?.argsKey === argsKey &&
          seen.version !== undefined &&
          seen.version > diff.version
        )
          setFetchNonce((n) => n + 1);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setLoad({
            argsKey,
            diff: null,
            files: null,
            error: errorMessage(e),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [args, argsKey, fetchNonce]);
  const diff = shown?.diff ?? null;
  const repo = diff?.repo;
  useEffect(() => {
    document.title = repo ? `${repo} · revue` : "revue";
  }, [repo]);
  const parsedFiles = shown?.files ?? null;
  const diffError = shown?.error ?? null;
  const version = diff?.version ?? null;

  // Live updates: thread events refetch the threads; a diff.changed
  // notice with a version other than the one on screen refetches the
  // diff. The notice also opens every stream, so a reconnect catches
  // up on anything missed. Before a diff for these arguments is on
  // screen there is nothing to compare, and the fetch in flight
  // answers it.
  const connection = useEvents(args, (e) => {
    if (e.type === "diff.changed") {
      const next = (e.payload as { version?: number } | null)?.version;
      notice.current = { argsKey, version: next };
      if (shown === null) return;
      if (next === undefined || next !== version) {
        setFetchNonce((n) => n + 1);
        setPulse((p) => p + 1);
      }
      return;
    }
    loadThreads();
  });

  // A viewed file collapses to its header, like on GitHub. The arrow in
  // a header overrides that either way, and so does a jump into the file
  // (a thread, the tree), which opens it; ticking the box drops the
  // override, so the file follows its viewed state again.
  const [collapseOverride, setCollapseOverride] = useState<
    ReadonlyMap<string, boolean>
  >(new Map());
  const collapsed = useMemo(() => {
    const next = new Set(viewed);
    for (const [path, isCollapsed] of collapseOverride) {
      if (isCollapsed) next.add(path);
      else next.delete(path);
    }
    return next;
  }, [viewed, collapseOverride]);
  const overrideCollapse = useCallback((path: string, value: boolean) => {
    setCollapseOverride((prev) =>
      prev.get(path) === value ? prev : new Map(prev).set(path, value),
    );
  }, []);
  const toggleViewed = useCallback((path: string) => {
    setViewed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setCollapseOverride((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, []);
  const toggleCollapsed = useCallback(
    (path: string) => overrideCollapse(path, !collapsed.has(path)),
    [collapsed, overrideCollapse],
  );

  const diffViewRef = useRef<DiffViewHandle>(null);
  // A jump runs after the render that opens its file, so it scrolls
  // through the file's expanded layout.
  const [jump, setJump] = useState<{
    path: string;
    side?: Side;
    line?: number;
  } | null>(null);
  const reveal = useCallback(
    (target: NonNullable<typeof jump>) => {
      overrideCollapse(target.path, false);
      setJump(target);
    },
    [overrideCollapse],
  );
  useEffect(() => {
    if (!jump) return;
    if (jump.side !== undefined && jump.line !== undefined)
      diffViewRef.current?.scrollToLine(jump.path, jump.side, jump.line);
    else diffViewRef.current?.scrollToFile(jump.path);
  }, [jump]);
  const scrollToFile = useCallback(
    (path: string) => {
      setSelectedPath(path);
      reveal({ path });
    },
    [reveal],
  );

  const diffFiles = useMemo(() => diff?.files ?? [], [diff]);
  const lineTotals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of parsedFiles ?? []) {
      for (const h of f.hunks) {
        additions += h.additionLines;
        deletions += h.deletionLines;
      }
    }
    return { additions, deletions };
  }, [parsedFiles]);
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
  const loadFile = useCallback(
    async (path: string) => loadedFiles(await api.getDiffFile(args, path)),
    [args],
  );
  const richByFile = useRichDocs(args, parsedFiles, richPaths);
  const imageUrl = useCallback(
    (path: string, side: "old" | "new") =>
      api.diffImageUrl(args, path, side, version ?? 0),
    [args, version],
  );

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
                // The diff on screen places the new thread at its
                // origin until the next fetch, so no refetch here.
                loadThreads();
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
        reveal({
          path: position.path,
          side: position.side,
          line: position.line,
        });
      } else {
        setSnapshotId(thread.id);
      }
    },
    [reveal],
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
      rounds
        .flatMap((r) => r.threads)
        .filter(
          (t) => positions.get(t.id)?.state !== "live" || t.id === snapshotId,
        ),
    [rounds, positions, snapshotId],
  );
  const snapshotIndex = outdated.findIndex((t) => t.id === snapshotId);
  const snapshotThread = snapshotIndex >= 0 ? outdated[snapshotIndex] : null;
  const prevSnapshot = useCallback(
    () => openSnapshot(outdated[snapshotIndex - 1].id),
    [openSnapshot, outdated, snapshotIndex],
  );
  const nextSnapshot = useCallback(
    () => openSnapshot(outdated[snapshotIndex + 1].id),
    [openSnapshot, outdated, snapshotIndex],
  );

  const openComposer = useCallback(() => {
    setShowPanel(true);
    setComposerFocus((n) => n + 1);
  }, []);

  // One path for both ways to send: the composer's, with the note, and
  // the top bar's, drafts only. A failed quick send opens the composer,
  // where the error shows.
  const sendRound = useCallback(
    async (text: string): Promise<boolean> => {
      setSending(true);
      setSendError(null);
      try {
        await api.send(text);
        loadThreads();
        return true;
      } catch (e) {
        setSendError(errorMessage(e));
        if (text === "") openComposer();
        return false;
      } finally {
        setSending(false);
      }
    },
    [loadThreads, openComposer],
  );
  const sendNow = useCallback(() => void sendRound(""), [sendRound]);

  return (
    <TooltipProvider>
      <FocusedThreadContext.Provider value={focusedId}>
        <div className="flex h-full flex-col">
          <ConnectionBanner state={connection} />
          <TopBar
            repo={repo}
            branch={diff?.branch}
            args={args}
            onNavigate={onNavigate}
            pulse={pulse}
            threadCount={threads.length}
            panelOpen={showPanel}
            onTogglePanel={togglePanel}
            draftCount={draftCount}
            onSendNow={sendNow}
            onCompose={openComposer}
            sending={sending}
            diffStyle={diffStyle}
            onDiffStyleChange={changeDiffStyle}
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
                    additions={lineTotals.additions}
                    deletions={lineTotals.deletions}
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
                  ) : parsedFiles === null ? (
                    <LoadingBlocks
                      className="flex-1 p-4"
                      data-testid="diff-loading"
                      label="Loading diff…"
                      bars={[
                        "h-9 w-full",
                        "h-4 w-3/4",
                        "h-4 w-2/3",
                        "h-4 w-4/5",
                        "mt-6 h-9 w-full",
                        "h-4 w-1/2",
                        "h-4 w-3/5",
                      ]}
                    />
                  ) : (
                    <DiffView
                      ref={diffViewRef}
                      files={parsedFiles}
                      diffFiles={diffFiles}
                      diffStyle={diffStyle}
                      theme={theme}
                      annotationsByFile={annotationsByFile}
                      renderAnnotation={renderAnnotation}
                      onLineSelect={onLineSelect}
                      loadFile={loadFile}
                      richByFile={richByFile}
                      onToggleRich={toggleRich}
                      imageUrl={imageUrl}
                      viewed={viewed}
                      onToggleViewed={toggleViewed}
                      collapsed={collapsed}
                      onToggleCollapsed={toggleCollapsed}
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
                    onPrev={prevSnapshot}
                    onNext={nextSnapshot}
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
                    rounds={rounds}
                    positions={positions}
                    onJump={jumpToThread}
                    activeId={snapshotThread?.id ?? focusedId}
                    onClose={closePanel}
                    footer={
                      <SendComposer
                        draftCount={draftCount}
                        initialNote={note}
                        onKeepNote={setNote}
                        onSend={sendRound}
                        sending={sending}
                        error={sendError}
                        focusSignal={composerFocus}
                      />
                    }
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
      </FocusedThreadContext.Provider>
    </TooltipProvider>
  );
}
