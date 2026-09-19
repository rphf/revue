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
  ReviewDetail,
  RoundDetail,
  Side,
  Thread as ThreadType,
  ThreadAnchor,
  Verdict,
} from "../types";
import { CircleAlertIcon } from "lucide-react";
import CommentForm from "../components/CommentForm";
import ConnectionBanner from "../components/ConnectionBanner";
import { useFullDiffs } from "../components/ContextExpand";
import DiffView, {
  type AnnotationMeta,
  type DiffStyle,
  type DiffViewHandle,
  type PendingComment,
} from "../components/DiffView";
import FileTree from "../components/FileTree";
import SubmitDialog from "../components/SubmitDialog";
import Thread from "../components/Thread";
import ThreadsPanel from "../components/ThreadsPanel";
import TopBar, { Brand, TopBarShell } from "../components/TopBar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";

export interface ReviewPageProps {
  reviewId: number;
  theme: Theme;
  onToggleTheme: () => void;
  onNavigate: (to: string) => void;
}

// One fetch of a round, tagged with the key it was requested under, so
// a stale result is ignored by derivation instead of reset in an effect.
interface RoundLoad {
  key: string;
  detail: RoundDetail | null;
  patch: string | null;
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

// threadRev fingerprints a thread's visible content so annotation
// equality can tell "same anchor, changed conversation" apart.
function threadRev(t: ThreadType): string {
  return `${t.resolved ? 1 : 0}|${t.comments.map((c) => `${c.id}#${c.draft ? 1 : 0}#${c.body}`).join("\u0000")}`;
}

export default function ReviewPage({
  reviewId,
  theme,
  onToggleTheme,
  onNavigate,
}: ReviewPageProps) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  // null tracks the latest round; a number pins a frozen prior round.
  const [roundSeq, setRoundSeq] = useState<number | null>(null);
  const [roundLoad, setRoundLoad] = useState<RoundLoad | null>(null);
  const [threads, setThreads] = useState<ThreadType[]>([]);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(loadDiffStyle);
  useEffect(() => saveDiffStyle(diffStyle), [diffStyle]);
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string>();

  const loadReview = useCallback(() => {
    api
      .getReview(reviewId)
      .then(setDetail)
      .catch((e) => setError(String(e)));
  }, [reviewId]);

  const loadThreads = useCallback(() => {
    api
      .listThreads(reviewId)
      .then((r) => setThreads(r.threads))
      .catch((e) => setError(String(e)));
  }, [reviewId]);

  useEffect(loadReview, [loadReview]);
  useEffect(loadThreads, [loadThreads]);

  const latestSeq = detail?.rounds.length
    ? detail.rounds[detail.rounds.length - 1].seq
    : null;
  const effectiveSeq = roundSeq ?? latestSeq;

  const [roundFetchNonce, setRoundFetchNonce] = useState(0);
  const roundKey = `${reviewId}:${effectiveSeq}:${roundFetchNonce}`;
  useEffect(() => {
    if (effectiveSeq === null) return;
    let cancelled = false;
    Promise.all([
      api.getRound(reviewId, effectiveSeq),
      api.getPatch(reviewId, effectiveSeq),
    ])
      .then(([round, patchText]) => {
        if (cancelled) return;
        const files =
          patchText.trim() === ""
            ? []
            : parsePatchFiles(patchText).flatMap((p) => p.files);
        setRoundLoad({
          key: roundKey,
          detail: round,
          patch: patchText,
          files,
          error: null,
        });
      })
      .catch((e) => {
        if (!cancelled)
          setRoundLoad({
            key: roundKey,
            detail: null,
            patch: null,
            files: null,
            error: String(e),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, effectiveSeq, roundFetchNonce, roundKey]);
  const loaded = roundLoad?.key === roundKey ? roundLoad : null;
  const roundDetail = loaded?.detail ?? null;
  const patch = loaded?.patch ?? null;
  const parsedFiles = loaded?.files ?? null;
  const roundError = loaded?.error ?? null;

  // Live updates (R7): agent replies and new rounds appear without
  // reload. Draft edits are local-only, so refetching on every event
  // is cheap and safe.
  const connection = useEvents(reviewId, () => {
    loadReview();
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

  const roundFiles = useMemo(() => roundDetail?.files ?? [], [roundDetail]);
  const currentRoundId = roundDetail?.round.id ?? 0;
  const viewingLatest = effectiveSeq !== null && effectiveSeq === latestSeq;
  // R25: expansion content comes from the frozen snapshot.
  const { files: displayFiles, requestUpgrade } = useFullDiffs(
    reviewId,
    effectiveSeq,
    parsedFiles,
    roundFiles,
    patch,
  );
  const reviewState = detail?.review.state ?? "open";

  const draftCount = useMemo(
    () => threads.flatMap((t) => t.comments).filter((c) => c.draft).length,
    [threads],
  );

  // Inline annotations: every thread with a live anchor in the shown
  // round, plus the single pending comment form. Each annotation's
  // metadata carries what rendering it needs, and DiffView compares
  // annotation content per file, so a thread reload (every SSE event)
  // re-renders only the file diffs whose annotations actually changed.
  const annotationsByFile = useMemo(() => {
    const next = new Map<string, DiffLineAnnotation<AnnotationMeta>[]>();
    const push = (path: string, a: DiffLineAnnotation<AnnotationMeta>) => {
      const list = next.get(path) ?? [];
      list.push(a);
      next.set(path, list);
    };
    for (const t of threads) {
      const anchor = t.anchors.find(
        (a) => a.roundId === currentRoundId && a.state === "live",
      );
      if (anchor) {
        push(anchor.path, {
          side: anchor.side,
          lineNumber: anchor.line,
          // rev captures the thread's visible content: any reply,
          // edit, resolve, or review state change re-renders just
          // that file.
          metadata: {
            kind: "thread",
            threadId: t.id,
            rev: `${reviewState}|${threadRev(t)}`,
            thread: t,
            reviewState,
          },
        });
      }
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
  }, [threads, currentRoundId, pending, reviewState]);

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationMeta>) => {
      const meta = annotation.metadata;
      if (meta?.kind === "pending" && meta.pending) {
        const p = meta.pending;
        return (
          <div className="annotation-card p-2.5">
            <CommentForm
              placeholder={
                p.startLine && p.startLine !== p.line
                  ? `Comment on lines ${p.startLine}–${p.line}`
                  : `Comment on line ${p.line}`
              }
              submitLabel="Start thread"
              onSubmit={async (body) => {
                await api.createThread(reviewId, {
                  path: p.path,
                  side: p.side,
                  line: p.line,
                  startLine: p.startLine,
                  body,
                });
                setPending(null);
                diffViewRef.current?.clearSelection();
                loadThreads();
              }}
              onCancel={() => {
                setPending(null);
                diffViewRef.current?.clearSelection();
              }}
            />
          </div>
        );
      }
      if (meta?.kind === "thread" && meta.thread) {
        return (
          <Thread
            thread={meta.thread}
            anchorState="live"
            reviewState={meta.reviewState ?? "open"}
            onChanged={loadThreads}
            onJumpToOrigin={(seq) => setRoundSeq(seq)}
          />
        );
      }
      return null;
    },
    [reviewId, loadThreads],
  );

  const onLineSelect = useCallback((path: string, range: SelectedLineRange) => {
    const side = (range.endSide ?? range.side ?? "additions") as Side;
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    setPending({
      path,
      side,
      line: end,
      startLine: start !== end ? start : undefined,
    });
  }, []);

  // R22: a live thread scrolls to its anchor; an outdated or orphaned
  // one jumps to its originating round snapshot.
  const jumpToThread = useCallback(
    (thread: ThreadType, anchor: ThreadAnchor | undefined) => {
      if (anchor && anchor.state === "live") {
        scrollToFile(anchor.path);
      } else {
        setRoundSeq(thread.originRoundSeq);
        const origin = thread.anchors.find(
          (a) => a.roundId === thread.originRoundId,
        );
        if (origin) setSelectedPath(origin.path);
      }
      setShowPanel(false);
    },
    [scrollToFile],
  );

  const submitReview = useCallback(
    async (verdict: Verdict, summary: string) => {
      await api.submit(reviewId, verdict, summary);
      setShowSubmit(false);
      loadReview();
      loadThreads();
    },
    [reviewId, loadReview, loadThreads],
  );

  const lifecycleAction = useCallback(
    (action: "close" | "reopen") => {
      const call = action === "close" ? api.close : api.reopen;
      call(reviewId)
        .then(() => {
          setNotice(null);
          loadReview();
        })
        .catch((e) => setNotice(e instanceof Error ? e.message : String(e)));
    },
    [reviewId, loadReview],
  );

  if (error) {
    return (
      <TooltipProvider>
        <div className="flex h-full flex-col">
          <TopBarShell>
            <Brand />
          </TopBarShell>
          <main className="grid flex-1 place-items-center p-6">
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <CircleAlertIcon className="size-6 text-destructive" />
              <p className="text-destructive">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate("/")}
              >
                Back to reviews
              </Button>
            </div>
          </main>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <ConnectionBanner state={connection} />
        <TopBar
          review={detail?.review}
          rounds={detail?.rounds ?? []}
          currentSeq={effectiveSeq}
          latestSeq={latestSeq}
          roundBusy={roundDetail === null && roundError === null}
          onSelectRound={(seq) => setRoundSeq(seq === latestSeq ? null : seq)}
          threadCount={threads.length}
          panelOpen={showPanel}
          onTogglePanel={() => setShowPanel((v) => !v)}
          draftCount={draftCount}
          onSubmit={() => setShowSubmit(true)}
          onClose={() => lifecycleAction("close")}
          onReopen={() => lifecycleAction("reopen")}
          diffStyle={diffStyle}
          onDiffStyleChange={setDiffStyle}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onNavigate={onNavigate}
        />
        {notice && (
          <p
            className="flex items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
            role="alert"
          >
            <CircleAlertIcon className="size-3.5" />
            {notice}
          </p>
        )}
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[272px] shrink-0 flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground">
            <FileTree
              files={roundFiles}
              viewed={viewed}
              onToggleViewed={toggleViewed}
              onSelect={scrollToFile}
              selectedPath={selectedPath}
            />
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            {roundError !== null ? (
              <div
                className="flex flex-1 flex-col items-center justify-center gap-3"
                data-testid="diff-error"
              >
                <CircleAlertIcon className="size-6 text-destructive" />
                <p className="text-destructive">{roundError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRoundFetchNonce((n) => n + 1)}
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
                roundFiles={roundFiles}
                diffStyle={diffStyle}
                theme={theme}
                annotationsByFile={annotationsByFile}
                renderAnnotation={renderAnnotation}
                onLineSelect={
                  reviewState !== "closed" && viewingLatest
                    ? onLineSelect
                    : undefined
                }
                onExpandContext={requestUpgrade}
              />
            )}
          </main>
          {showPanel && (
            <aside className="w-[360px] shrink-0 overflow-hidden border-l bg-sidebar text-sidebar-foreground">
              <ThreadsPanel
                threads={threads}
                currentRoundId={currentRoundId}
                onJump={jumpToThread}
                onClose={() => setShowPanel(false)}
              />
            </aside>
          )}
        </div>
        {showSubmit && (
          <SubmitDialog
            draftCount={draftCount}
            onSubmit={submitReview}
            onClose={() => setShowSubmit(false)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
