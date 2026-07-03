import { useCallback, useEffect, useMemo, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { api } from "../api";
import { useEvents } from "../useEvents";
import type { Theme } from "../theme";
import type { ReviewDetail, RoundDetail, Side, Thread as ThreadType, ThreadAnchor, Verdict } from "../types";
import { StateChip, ThemeToggle } from "../App";
import CommentForm from "../components/CommentForm";
import ConnectionBanner from "../components/ConnectionBanner";
import DiffView, { fileDomId, type AnnotationMeta, type DiffStyle } from "../components/DiffView";
import FileTree from "../components/FileTree";
import SubmitDialog from "../components/SubmitDialog";
import Thread from "../components/Thread";
import ThreadsPanel from "../components/ThreadsPanel";

export interface ReviewPageProps {
  reviewId: number;
  theme: Theme;
  onToggleTheme: () => void;
  onNavigate: (to: string) => void;
}

interface PendingComment {
  path: string;
  side: Side;
  line: number;
  startLine?: number;
}

export default function ReviewPage({ reviewId, theme, onToggleTheme, onNavigate }: ReviewPageProps) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  // U9 adds a round switcher; until then the latest round is shown.
  const roundSeq: number | null = null;
  const [roundDetail, setRoundDetail] = useState<RoundDetail | null>(null);
  const [parsedFiles, setParsedFiles] = useState<FileDiffMetadata[] | null>(null);
  const [threads, setThreads] = useState<ThreadType[]>([]);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
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

  const latestSeq = detail?.rounds.length ? detail.rounds[detail.rounds.length - 1].seq : null;
  const effectiveSeq = roundSeq ?? latestSeq;

  useEffect(() => {
    if (effectiveSeq === null) return;
    let cancelled = false;
    setRoundDetail(null);
    setParsedFiles(null);
    Promise.all([api.getRound(reviewId, effectiveSeq), api.getPatch(reviewId, effectiveSeq)])
      .then(([round, patch]) => {
        if (cancelled) return;
        setRoundDetail(round);
        if (patch.trim() === "") {
          setParsedFiles([]);
          return;
        }
        const parsed = parsePatchFiles(patch);
        setParsedFiles(parsed.flatMap((p) => p.files));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, effectiveSeq]);

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

  const scrollToFile = useCallback((path: string) => {
    setSelectedPath(path);
    document.getElementById(fileDomId(path))?.scrollIntoView({ block: "start" });
  }, []);

  const roundFiles = useMemo(() => roundDetail?.files ?? [], [roundDetail]);
  const currentRoundId = roundDetail?.round.id ?? 0;
  const reviewState = detail?.review.state ?? "open";

  const draftCount = useMemo(
    () => threads.flatMap((t) => t.comments).filter((c) => c.draft).length,
    [threads],
  );

  // Inline annotations: every thread with a live anchor in the shown
  // round, plus the single pending comment form.
  const annotationsByFile = useMemo(() => {
    const map = new Map<string, DiffLineAnnotation<AnnotationMeta>[]>();
    const push = (path: string, a: DiffLineAnnotation<AnnotationMeta>) => {
      const list = map.get(path) ?? [];
      list.push(a);
      map.set(path, list);
    };
    for (const t of threads) {
      const anchor = t.anchors.find((a) => a.roundId === currentRoundId && a.state === "live");
      if (anchor) {
        push(anchor.path, {
          side: anchor.side,
          lineNumber: anchor.line,
          metadata: { kind: "thread", threadId: t.id },
        });
      }
    }
    if (pending) {
      push(pending.path, {
        side: pending.side,
        lineNumber: pending.line,
        metadata: { kind: "pending" },
      });
    }
    return map;
  }, [threads, currentRoundId, pending]);

  const threadsById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationMeta>, path: string) => {
      const meta = annotation.metadata;
      if (meta?.kind === "pending" && pending && pending.path === path) {
        return (
          <CommentForm
            placeholder={
              pending.startLine && pending.startLine !== pending.line
                ? `Comment on lines ${pending.startLine}–${pending.line}`
                : `Comment on line ${pending.line}`
            }
            submitLabel="Start thread"
            onSubmit={async (body) => {
              await api.createThread(reviewId, {
                path: pending.path,
                side: pending.side,
                line: pending.line,
                startLine: pending.startLine,
                body,
              });
              setPending(null);
              loadThreads();
            }}
            onCancel={() => setPending(null)}
          />
        );
      }
      if (meta?.kind === "thread" && meta.threadId !== undefined) {
        const thread = threadsById.get(meta.threadId);
        if (!thread) return null;
        return (
          <Thread
            thread={thread}
            anchorState="live"
            reviewState={reviewState}
            onChanged={loadThreads}
          />
        );
      }
      return null;
    },
    [pending, reviewId, threadsById, reviewState, loadThreads],
  );

  const onGutterAdd = useCallback((path: string, side: Side, lineNumber: number) => {
    setPending({ path, side, line: lineNumber });
  }, []);

  const onLineSelect = useCallback((path: string, range: SelectedLineRange) => {
    const side = (range.endSide ?? range.side ?? "additions") as Side;
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    setPending({ path, side, line: end, startLine: start !== end ? start : undefined });
  }, []);

  const jumpToThread = useCallback(
    (thread: ThreadType, anchor: ThreadAnchor | undefined) => {
      const target = anchor ?? thread.anchors.find((a) => a.roundId === thread.originRoundId);
      if (target) scrollToFile(target.path);
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
          <button type="button" className="back-link" onClick={() => onNavigate("/")}>
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
        <button type="button" className="back-link" onClick={() => onNavigate("/")}>
          ← reviews
        </button>
        {detail && (
          <>
            <span className="review-title">
              #{detail.review.id} {detail.review.branch || detail.review.sourceArgs.join(" ") || "working tree"}
            </span>
            <StateChip state={detail.review.state} />
            {effectiveSeq !== null && <span className="round-label">round {effectiveSeq}</span>}
          </>
        )}
        <div className="topbar-actions">
          <button type="button" className="style-toggle" onClick={() => setShowPanel((v) => !v)}>
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
              <button type="button" className="style-toggle" onClick={() => lifecycleAction("close")}>
                Close
              </button>
            </>
          ) : (
            <button type="button" className="style-toggle" onClick={() => lifecycleAction("reopen")}>
              Reopen
            </button>
          )}
          <button
            type="button"
            className="style-toggle"
            onClick={() => setDiffStyle((s) => (s === "unified" ? "split" : "unified"))}
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
          {parsedFiles === null ? (
            <div className="diff-loading" data-testid="diff-loading">
              Loading diff…
            </div>
          ) : (
            <DiffView
              files={parsedFiles}
              roundFiles={roundFiles}
              diffStyle={diffStyle}
              theme={theme}
              annotationsByFile={annotationsByFile}
              renderAnnotation={renderAnnotation}
              onGutterAdd={reviewState !== "closed" ? onGutterAdd : undefined}
              onLineSelect={reviewState !== "closed" ? onLineSelect : undefined}
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
        <SubmitDialog draftCount={draftCount} onSubmit={submitReview} onClose={() => setShowSubmit(false)} />
      )}
    </div>
  );
}
