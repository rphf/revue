import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ThreadsPanel from "./ThreadsPanel";
import type { Thread, ThreadPosition } from "../types";

function position(
  threadId: number,
  state: ThreadPosition["state"],
  line = 5,
): ThreadPosition {
  return { threadId, path: "a.go", side: "additions", line, state };
}

function thread(
  id: number,
  opts: { resolved?: boolean; path?: string } = {},
): Thread {
  return {
    id,
    path: opts.path ?? "a.go",
    side: "additions",
    line: 5,
    resolved: opts.resolved ?? false,
    createdAt: "",
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
    // Live in the shown diff, at a shifted line.
    thread(1),
    // Its hunk changed: outdated, shown at its origin.
    thread(2),
    // Resolved (and live): resolved wins.
    thread(3, { resolved: true }),
    // Its file is gone from the diff: no position at all, still listed.
    thread(4, { path: "deleted/file.go" }),
  ];
  const positions = new Map<number, ThreadPosition>([
    [1, position(1, "live", 9)],
    [2, position(2, "outdated")],
    [3, position(3, "live")],
  ]);

  // The filter tabs activate on pointer down, as Radix tabs do, so the
  // test drives them with a full pointer sequence.
  it("partitions threads across live/outdated/resolved filters", async () => {
    const user = userEvent.setup();
    render(
      <ThreadsPanel
        threads={threads}
        positions={positions}
        onJump={() => {}}
        onClose={() => {}}
      />,
    );

    // All by default.
    expect(screen.getAllByTestId(/panel-thread-/)).toHaveLength(4);

    await user.click(screen.getByRole("tab", { name: /live/ }));
    let rows = screen.getAllByTestId(/panel-thread-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("thread 1 body");

    await user.click(screen.getByRole("tab", { name: /outdated/ }));
    rows = screen.getAllByTestId(/panel-thread-/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("thread 2 body");
    expect(rows[1]).toHaveTextContent("thread 4 body");

    await user.click(screen.getByRole("tab", { name: /resolved/ }));
    rows = screen.getAllByTestId(/panel-thread-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("thread 3 body");
  });

  it("shows the live line for live threads and the origin otherwise", () => {
    render(
      <ThreadsPanel
        threads={threads}
        positions={positions}
        onJump={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("panel-thread-1")).toHaveTextContent("a.go:9");
    expect(screen.getByTestId("panel-thread-2")).toHaveTextContent(
      "not in this diff",
    );
    expect(screen.getByTestId("panel-thread-4")).toHaveTextContent(
      "deleted/file.go:5",
    );
  });

  it("reports jumps with the thread's position when there is one", () => {
    const onJump = vi.fn();
    render(
      <ThreadsPanel
        threads={threads}
        positions={positions}
        onJump={onJump}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("panel-thread-1"));
    expect(onJump).toHaveBeenCalledWith(threads[0], positions.get(1));

    fireEvent.click(screen.getByTestId("panel-thread-4"));
    expect(onJump).toHaveBeenCalledWith(threads[3], undefined);
  });
});
