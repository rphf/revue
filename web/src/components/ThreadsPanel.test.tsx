import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: {
    getBranches: vi.fn(async () => ({
      current: "main",
      branches: [
        { name: "main", open: 4, archived: 0 },
        { name: "feat", open: 1, archived: 2 },
      ],
    })),
    listThreads: vi.fn(async () => ({
      threads: [thread(9, { path: "feat.go" })],
    })),
    getHistory: vi.fn(async (branch: string) => ({
      branch,
      current: "main",
      branches: [],
      commits: [
        {
          hash: "c".repeat(40),
          subject: "landed commit",
          date: "2026-09-24T10:00:00Z",
          onBranch: true,
          threads: [thread(7, { resolved: true }), thread(8)],
        },
      ],
      more: false,
    })),
  },
}));

import { api } from "../api";
import ThreadsPanel from "./ThreadsPanel";
import type { Send, Thread, ThreadPosition } from "../types";
import { groupByRound } from "@/lib/rounds";

function position(
  threadId: number,
  state: ThreadPosition["state"],
  line = 5,
): ThreadPosition {
  return { threadId, path: "a.go", side: "additions", line, state };
}

function thread(
  id: number,
  opts: { resolved?: boolean; path?: string; sendId?: number } = {},
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
        sendId: opts.sendId ?? 1,
        createdAt: "",
      },
    ],
  };
}

const oneSend: Send[] = [{ id: 1, note: "", createdAt: "" }];

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
        sends={oneSend}
        rounds={groupByRound(threads, oneSend)}
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
        sends={oneSend}
        rounds={groupByRound(threads, oneSend)}
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
        sends={oneSend}
        rounds={groupByRound(threads, oneSend)}
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

  it("groups threads per send, newest first, older rounds collapsed", () => {
    const sends: Send[] = [
      { id: 1, note: "first pass", createdAt: "2026-09-20T10:00:00Z" },
      { id: 2, note: "second pass", createdAt: "2026-09-20T11:00:00Z" },
    ];
    const draft = thread(3);
    draft.comments[0] = {
      ...draft.comments[0],
      draft: true,
      sendId: undefined,
    };
    render(
      <ThreadsPanel
        sends={oneSend}
        rounds={groupByRound(
          [thread(1, { sendId: 1 }), thread(2, { sendId: 2 }), draft],
          sends,
        )}
        positions={positions}
        onJump={() => {}}
        onClose={() => {}}
      />,
    );

    const headers = screen.getAllByRole("button", { expanded: true });
    expect(headers.map((h) => h.textContent)).toEqual([
      expect.stringContaining("Not sent yet"),
      expect.stringContaining("Round 2"),
    ]);
    expect(screen.getByTestId("panel-round-send-2")).toHaveTextContent(
      "second pass",
    );
    expect(screen.getByTestId("panel-thread-2")).toBeInTheDocument();
    expect(screen.getByTestId("panel-thread-3")).toBeInTheDocument();

    // The first send is collapsed: its header shows, its thread does not.
    const first = screen.getByRole("button", { name: /Round 1/ });
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("panel-thread-1")).not.toBeInTheDocument();

    fireEvent.click(first);
    expect(screen.getByTestId("panel-thread-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Round 2/ }));
    expect(screen.queryByTestId("panel-thread-2")).not.toBeInTheDocument();
  });

  it("opens a collapsed round holding the thread on screen", () => {
    const sends: Send[] = [
      { id: 1, note: "", createdAt: "2026-09-20T10:00:00Z" },
      { id: 2, note: "", createdAt: "2026-09-20T11:00:00Z" },
    ];
    render(
      <ThreadsPanel
        sends={oneSend}
        rounds={groupByRound(
          [thread(1, { sendId: 1 }), thread(2, { sendId: 2 })],
          sends,
        )}
        positions={positions}
        activeId={1}
        onJump={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("panel-thread-1")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("switches to History and keeps each archived thread's resolution", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    render(
      <ThreadsPanel
        sends={oneSend}
        rounds={groupByRound(threads, oneSend)}
        positions={positions}
        onJump={() => {}}
        onOpenThread={onOpenThread}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Branch")).toHaveValue("main"),
    );
    await user.click(screen.getByRole("radio", { name: "History" }));
    expect(await screen.findByText("landed commit")).toBeInTheDocument();
    expect(api.getHistory).toHaveBeenLastCalledWith("main", 200);
    await user.click(screen.getByRole("tab", { name: /unresolved/ }));
    expect(screen.queryByTestId("history-thread-7")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("history-thread-8"));
    expect(onOpenThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 8 }),
    );
  });

  it("lists another branch's threads and opens them on their snapshot", async () => {
    const onJump = vi.fn();
    const onOpenThread = vi.fn();
    render(
      <ThreadsPanel
        sends={oneSend}
        rounds={groupByRound(threads, oneSend)}
        positions={positions}
        onJump={onJump}
        onOpenThread={onOpenThread}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Branch")).toHaveValue("main"),
    );
    fireEvent.change(screen.getByLabelText("Branch"), {
      target: { value: "feat" },
    });
    await waitFor(() => expect(api.listThreads).toHaveBeenCalledWith("feat"));
    fireEvent.click(await screen.findByTestId("panel-thread-9"));
    expect(onOpenThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9 }),
    );
    expect(onJump).not.toHaveBeenCalled();
    expect(screen.getByText(/Threads of feat/)).toBeInTheDocument();
  });
});
