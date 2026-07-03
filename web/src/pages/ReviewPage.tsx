import { useCallback, useEffect, useMemo, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { api } from "../api";
import { useEvents } from "../useEvents";
import type { Theme } from "../theme";
import type { ReviewDetail, RoundDetail } from "../types";
import { StateChip, ThemeToggle } from "../App";
import ConnectionBanner from "../components/ConnectionBanner";
import DiffView, { fileDomId, type DiffStyle } from "../components/DiffView";
import FileTree from "../components/FileTree";

export interface ReviewPageProps {
  reviewId: number;
  theme: Theme;
  onToggleTheme: () => void;
  onNavigate: (to: string) => void;
}

export default function ReviewPage({ reviewId, theme, onToggleTheme, onNavigate }: ReviewPageProps) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  // U9 adds a round switcher; until then the latest round is shown.
  const roundSeq: number | null = null;
  const [roundDetail, setRoundDetail] = useState<RoundDetail | null>(null);
  const [parsedFiles, setParsedFiles] = useState<FileDiffMetadata[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string>();

  const loadReview = useCallback(() => {
    api
      .getReview(reviewId)
      .then(setDetail)
      .catch((e) => setError(String(e)));
  }, [reviewId]);

  useEffect(loadReview, [loadReview]);

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
        const trimmed = patch.trim();
        if (trimmed === "") {
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

  // Live updates (R7): any event refreshes review metadata; a new
  // round refreshes the diff if we are looking at the latest.
  const connection = useEvents(reviewId, () => {
    loadReview();
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
            <DiffView files={parsedFiles} roundFiles={roundFiles} diffStyle={diffStyle} theme={theme} />
          )}
        </main>
      </div>
    </div>
  );
}
