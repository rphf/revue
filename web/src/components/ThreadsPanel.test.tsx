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
import type { Comment, Thread, ThreadPosition } from "../types";

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

function withComments(t: Thread, ...more: Partial<Comment>[]): Thread {
  return {
    ...t,
    comments: [
      ...t.comments,
      ...more.map((c, i) => ({
        ...t.comments[0],
        id: t.id * 100 + i + 1,
        sendId: undefined,
        ...c,
      })),
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

    // All by default, with the resolved section folded.
    expect(screen.getAllByTestId(/panel-thread-/)).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Resolved/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

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

  it("groups threads by turn, yours and drafts open, the rest folded", () => {
    const answered = withComments(thread(1), {
      authorRole: "agent",
      body: "done, renamed it",
    });
    const drafted = withComments(thread(2), { draft: true });
    render(
      <ThreadsPanel
        threads={[thread(3), answered, thread(4, { resolved: true }), drafted]}
        positions={positions}
        onJump={() => {}}
        onClose={() => {}}
      />,
    );

    const headers = screen.getAllByRole("button", { expanded: true });
    expect(headers.map((h) => h.textContent)).toEqual([
      expect.stringContaining("Your turn"),
      expect.stringContaining("Drafts"),
    ]);
    expect(screen.getByTestId("panel-turn-yours")).toContainElement(
      screen.getByTestId("panel-thread-1"),
    );
    expect(screen.getByTestId("panel-turn-drafts")).toContainElement(
      screen.getByTestId("panel-thread-2"),
    );

    const waiting = screen.getByRole("button", { name: /Waiting on agent/ });
    expect(waiting).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("panel-thread-3")).not.toBeInTheDocument();
    fireEvent.click(waiting);
    expect(screen.getByTestId("panel-thread-3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Your turn/ }));
    expect(screen.queryByTestId("panel-thread-1")).not.toBeInTheDocument();
  });

  it("opens the first section when nothing waits on the reviewer", () => {
    render(
      <ThreadsPanel
        threads={[thread(1), thread(2, { resolved: true })]}
        positions={positions}
        onJump={() => {}}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Waiting on agent/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("panel-thread-1")).toBeInTheDocument();
  });

  it("opens a folded section holding the thread on screen", () => {
    render(
      <ThreadsPanel
        threads={[thread(1), thread(2, { resolved: true })]}
        positions={positions}
        activeId={2}
        onJump={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("panel-thread-2")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("shows the agent's answer, its notes, and the sends a thread went through", () => {
    const answered = withComments(
      thread(1),
      { authorRole: "agent", body: "why not keep it?" },
      { sendId: 2 },
      { authorRole: "agent", body: "kept, as asked" },
    );
    const note = withComments(thread(2), {});
    note.comments = [
      {
        ...note.comments[0],
        authorRole: "agent",
        body: "self review",
        sendId: undefined,
      },
    ];
    render(
      <ThreadsPanel
        threads={[answered, note]}
        positions={positions}
        onJump={() => {}}
        onClose={() => {}}
      />,
    );
    const row = screen.getByTestId("panel-thread-1");
    expect(row).toHaveTextContent("agent: kept, as asked");
    expect(row).toHaveTextContent("R2");
    expect(row).not.toHaveTextContent("agent note");

    const noteRow = screen.getByTestId("panel-thread-2");
    expect(noteRow).toHaveTextContent("agent note");
    expect(noteRow).not.toHaveTextContent("agent:");
    expect(noteRow).not.toHaveTextContent(/R\d/);
  });

  it("switches to History and keeps each archived thread's resolution", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    render(
      <ThreadsPanel
        threads={threads}
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
        threads={threads}
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
