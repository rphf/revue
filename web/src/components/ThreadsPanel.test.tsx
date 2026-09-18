import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ThreadsPanel from "./ThreadsPanel";
import type { Thread, ThreadAnchor } from "../types";

const CURRENT_ROUND = 20;
const ORIGIN_ROUND = 10;

let nextId = 1;
function anchor(
  threadId: number,
  roundId: number,
  state: ThreadAnchor["state"],
  path = "a.go",
): ThreadAnchor {
  return {
    id: nextId++,
    threadId,
    roundId,
    path,
    side: "additions",
    line: 5,
    state,
  };
}

function thread(
  id: number,
  opts: { resolved?: boolean; anchors: ThreadAnchor[] },
): Thread {
  return {
    id,
    reviewId: 1,
    originRoundId: ORIGIN_ROUND,
    resolved: opts.resolved ?? false,
    createdAt: "",
    originRoundSeq: 1,
    anchors: opts.anchors,
    comments: [
      {
        id: id * 100,
        threadId: id,
        authorRole: "reviewer",
        body: `thread ${id} body`,
        draft: false,
        createdAt: "",
      },
    ],
  };
}

describe("ThreadsPanel", () => {
  const threads = [
    // Live in the current round.
    thread(1, {
      anchors: [
        anchor(1, ORIGIN_ROUND, "live"),
        anchor(1, CURRENT_ROUND, "live"),
      ],
    }),
    // Outdated in the current round.
    thread(2, {
      anchors: [
        anchor(2, ORIGIN_ROUND, "live"),
        anchor(2, CURRENT_ROUND, "outdated"),
      ],
    }),
    // Resolved (and live) — resolved wins.
    thread(3, { resolved: true, anchors: [anchor(3, CURRENT_ROUND, "live")] }),
    // Orphaned: no anchor in the current round at all (file gone) —
    // still reachable, classified outdated (R22).
    thread(4, {
      anchors: [anchor(4, ORIGIN_ROUND, "live", "deleted/file.go")],
    }),
  ];

  it("partitions threads across live/outdated/resolved filters", () => {
    render(
      <ThreadsPanel
        threads={threads}
        currentRoundId={CURRENT_ROUND}
        onJump={() => {}}
        onClose={() => {}}
      />,
    );

    // All by default.
    expect(screen.getAllByTestId(/panel-thread-/)).toHaveLength(4);

    fireEvent.click(screen.getByRole("tab", { name: /live/ }));
    let rows = screen.getAllByTestId(/panel-thread-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("thread 1 body");

    fireEvent.click(screen.getByRole("tab", { name: /outdated/ }));
    rows = screen.getAllByTestId(/panel-thread-/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("thread 2 body");
    expect(rows[1]).toHaveTextContent("thread 4 body");

    fireEvent.click(screen.getByRole("tab", { name: /resolved/ }));
    rows = screen.getAllByTestId(/panel-thread-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("thread 3 body");
  });

  it("keeps orphaned threads reachable with their origin-round anchor shown", () => {
    render(
      <ThreadsPanel
        threads={threads}
        currentRoundId={CURRENT_ROUND}
        onJump={() => {}}
        onClose={() => {}}
      />,
    );
    const orphan = screen.getByTestId("panel-thread-4");
    expect(orphan).toHaveTextContent("deleted/file.go:5");
    expect(orphan).toHaveTextContent("round 1");
  });

  it("reports jumps with the current-round anchor when present", () => {
    const onJump = vi.fn();
    render(
      <ThreadsPanel
        threads={threads}
        currentRoundId={CURRENT_ROUND}
        onJump={onJump}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("panel-thread-1"));
    expect(onJump).toHaveBeenCalledWith(threads[0], threads[0].anchors[1]);

    fireEvent.click(screen.getByTestId("panel-thread-4"));
    expect(onJump).toHaveBeenCalledWith(threads[3], undefined);
  });
});
