import { useMemo, useState } from "react";
import type { Thread, ThreadAnchor } from "../types";

export type PanelFilter = "all" | "live" | "outdated" | "resolved";

export interface ThreadsPanelProps {
  threads: Thread[];
  currentRoundId: number;
  onJump: (thread: Thread, anchor: ThreadAnchor | undefined) => void;
  onClose: () => void;
}

// Review-level threads panel (R22): every thread with
// live/outdated/resolved filters. A thread whose file or hunk is gone
// from the current round stays reachable here and links back to its
// originating round.
export default function ThreadsPanel({
  threads,
  currentRoundId,
  onJump,
  onClose,
}: ThreadsPanelProps) {
  const [filter, setFilter] = useState<PanelFilter>("all");

  const classified = useMemo(
    () =>
      threads.map((t) => {
        const anchor = t.anchors.find((a) => a.roundId === currentRoundId);
        const state: PanelFilter = t.resolved
          ? "resolved"
          : anchor?.state === "live"
            ? "live"
            : "outdated";
        return { thread: t, anchor, state };
      }),
    [threads, currentRoundId],
  );

  const visible = classified.filter(
    (c) => filter === "all" || c.state === filter,
  );
  const count = (s: PanelFilter) =>
    classified.filter((c) => c.state === s).length;

  return (
    <div className="threads-panel" data-testid="threads-panel">
      <div className="panel-header">
        <strong>Threads</strong>
        <button type="button" className="link-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="panel-filters" role="tablist">
        {(["all", "live", "outdated", "resolved"] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={`panel-filter${filter === f ? " active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f}
            {f !== "all" && <span className="filter-count"> {count(f)}</span>}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="muted panel-empty">
          No {filter === "all" ? "" : filter + " "}threads
        </p>
      ) : (
        <ul className="panel-list">
          {visible.map(({ thread, anchor, state }) => {
            const origin = thread.anchors.find(
              (a) => a.roundId === thread.originRoundId,
            );
            const shown = anchor ?? origin;
            const first = thread.comments[0];
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  className="panel-thread"
                  data-testid={`panel-thread-${thread.id}`}
                  onClick={() => onJump(thread, anchor)}
                >
                  <span className="panel-anchor">
                    {shown ? `${shown.path}:${shown.line}` : "(unanchored)"}
                  </span>
                  <span className={`chip chip-${state}`}>{state}</span>
                  {state === "outdated" && (
                    <span className="muted">round {thread.originRoundSeq}</span>
                  )}
                  <span className="panel-excerpt">{first?.body ?? ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
