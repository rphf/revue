import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import type {
  CodeViewLineSelection,
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
import { StateChip, ThemeToggle } from "../App";
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
import RoundSwitcher from "../components/RoundSwitcher";
import SubmitDialog from "../components/SubmitDialog";
import Thread from "../components/Thread";
import ThreadsPanel from "../components/ThreadsPanel";

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

  const selectedLines = useMemo<CodeViewLineSelection | null>(
    () =>
      pending
        ? {
            id: pending.path,
            range: {
              start: pending.startLine ?? pending.line,
              end: pending.line,
              side: pending.side,
              endSide: pending.side,
            },
          }
        : null,
    [pending],
  );

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationMeta>) => {
      const meta = annotation.metadata;
      if (meta?.kind === "pending" && meta.pending) {
        const p = meta.pending;
        return (
          <div className="thread thread-new">
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
                loadThreads();
              }}
              onCancel={() => setPending(null)}
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
      <div className="page">
        <header className="topbar">
          <button
            type="button"
            className="back-link"
            onClick={() => onNavigate("/")}
          >
            ← reviews
          </button>
        </header>
        <p className="error">{error}</p>
      </div>
    );
  }

  return (
    <div className="page review-page">
      <ConnectionBanner state={connection} />
      <header className="topbar">
        <button
          type="button"
          className="back-link"
          onClick={() => onNavigate("/")}
        >
          ← reviews
        </button>
        {detail && (
          <>
            <span className="review-title">
              #{detail.review.id}{" "}
              {detail.review.branch ||
                detail.review.sourceArgs.join(" ") ||
                "working tree"}
            </span>
            <StateChip state={detail.review.state} />
            {effectiveSeq !== null && (
              <RoundSwitcher
                rounds={detail.rounds}
                current={effectiveSeq}
                disabled={roundDetail === null && roundError === null}
                onSelect={(seq) => setRoundSeq(seq === latestSeq ? null : seq)}
              />
            )}
            {effectiveSeq !== null && !viewingLatest && (
              <span className="chip chip-outdated">viewing a past round</span>
            )}
          </>
        )}
        <div className="topbar-actions">
          <button
            type="button"
            className="style-toggle"
            onClick={() => setShowPanel((v) => !v)}
          >
            threads{threads.length > 0 ? ` (${threads.length})` : ""}
          </button>
          {reviewState === "open" ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="open-submit"
                onClick={() => setShowSubmit(true)}
              >
                Submit review{draftCount > 0 ? ` (${draftCount})` : ""}
              </button>
              <button
                type="button"
                className="style-toggle"
                onClick={() => lifecycleAction("close")}
              >
                Close
              </button>
            </>
          ) : (
            <button
              type="button"
              className="style-toggle"
              onClick={() => lifecycleAction("reopen")}
            >
              Reopen
            </button>
          )}
          <button
            type="button"
            className="style-toggle"
            onClick={() =>
              setDiffStyle((s) => (s === "unified" ? "split" : "unified"))
            }
          >
            {diffStyle === "unified" ? "split view" : "unified view"}
          </button>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </header>
      {notice && (
        <p className="form-error" role="alert">
          {notice}
        </p>
      )}
      <div className="review-body">
        <aside className="sidebar">
          <FileTree
            files={roundFiles}
            viewed={viewed}
            onToggleViewed={toggleViewed}
            onSelect={scrollToFile}
            selectedPath={selectedPath}
          />
        </aside>
        <main className="diff-pane">
          {roundError !== null ? (
            <div className="diff-error" data-testid="diff-error">
              <p className="error">{roundError}</p>
              <button
                type="button"
                className="btn"
                onClick={() => setRoundFetchNonce((n) => n + 1)}
              >
                Retry
              </button>
            </div>
          ) : displayFiles === null ? (
            <div
              className="diff-loading diff-skeleton"
              data-testid="diff-loading"
            >
              Loading diff…
            </div>
          ) : (
            <DiffView
              ref={diffViewRef}
              files={displayFiles}
              roundFiles={roundFiles}
              diffStyle={diffStyle}
              theme={theme}
              annotationsByFile={annotationsByFile}
              selectedLines={selectedLines}
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
          <aside className="panel-sidebar">
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
  );
}
