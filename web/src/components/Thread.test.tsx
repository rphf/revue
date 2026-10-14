import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: {
    reply: vi.fn(async () => ({})),
    editComment: vi.fn(async () => ({})),
    deleteComment: vi.fn(async () => {}),
    resolveThread: vi.fn(async () => ({})),
    archiveThreads: vi.fn(async () => ({ archived: [1], skipped: [] })),
    unarchiveThread: vi.fn(async () => ({})),
  },
}));

import { api } from "../api";
import Thread from "./Thread";
import { FocusedCommentContext, FocusedThreadContext } from "./threadFocus";
import { comment, thread } from "../test/fixtures";

describe("Thread", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders replies in order with author roles", () => {
    const t = thread([
      comment({ body: "first: why this loop?" }),
      comment({ authorRole: "agent", body: "second: because of batching" }),
      comment({ body: "third: fair enough" }),
    ]);
    render(<Thread thread={t} onChanged={() => {}} />);

    const items = screen.getAllByTestId(/comment-/);
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("reviewer");
    expect(items[0]).toHaveTextContent("first: why this loop?");
    expect(items[1]).toHaveTextContent("agent");
    expect(items[1]).toHaveTextContent("second: because of batching");
    expect(items[2]).toHaveTextContent("third: fair enough");
  });

  it("renders script tags in comment bodies inertly (sanitized markdown)", () => {
    const t = thread([
      comment({
        authorRole: "agent",
        body: 'before <script>window.__pwned = true</script> <img src=x onerror="window.__pwned=true"> after',
      }),
    ]);
    render(<Thread thread={t} onChanged={() => {}} />);
    expect(document.querySelector("script")).toBeNull();
    const img = document.querySelector("img");
    expect(img?.getAttribute("onerror") ?? null).toBeNull();
    expect(
      (window as unknown as { __pwned?: boolean }).__pwned,
    ).toBeUndefined();
    expect(screen.getByTestId("thread-1")).toHaveTextContent("before");
    expect(screen.getByTestId("thread-1")).toHaveTextContent("after");
  });

  it("supports the draft edit and delete cycle", async () => {
    const onChanged = vi.fn();
    const draft = comment({ body: "draft body", draft: true });
    const t = thread([draft]);
    render(<Thread thread={t} onChanged={onChanged} />);

    expect(screen.getByText("Draft")).toBeInTheDocument();

    // Edit
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox");
    expect(box).toHaveValue("draft body");
    fireEvent.change(box, { target: { value: "draft body v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() =>
      expect(api.editComment).toHaveBeenCalledWith(draft.id, "draft body v2"),
    );
    expect(onChanged).toHaveBeenCalled();

    // Delete asks inline, then deletes on the second Delete.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("status")).toHaveTextContent("Delete this draft?");
    expect(api.deleteComment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(api.deleteComment).toHaveBeenCalledWith(draft.id),
    );
  });

  it("hides edit/delete on submitted comments", () => {
    const t = thread([comment({ body: "published" })]);
    render(<Thread thread={t} onChanged={() => {}} />);
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });

  it("replies through the api", async () => {
    const t = thread([comment({ body: "question" })]);
    render(<Thread thread={t} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "an answer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(api.reply).toHaveBeenCalledWith(1, "an answer"));
  });

  it("resolves and unresolves", async () => {
    const t = thread([comment({ body: "x" })]);
    const { rerender } = render(<Thread thread={t} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(api.resolveThread).toHaveBeenCalledWith(1, true),
    );

    rerender(
      <Thread
        thread={thread([comment({ body: "x" })], { resolved: true })}

        onChanged={() => {}}
      />,
    );
    // Resolving folds the thread, as GitHub does.
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open the thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Unresolve" }));
    await waitFor(() =>
      expect(api.resolveThread).toHaveBeenCalledWith(1, false),
    );
  });

  it("archives a thread, and not while it holds a draft", async () => {
    const onChanged = vi.fn();
    const { rerender } = render(
      <Thread
        thread={thread([comment({ body: "sent" })])}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Archive/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.archiveThreads).toHaveBeenCalledWith({ ids: [1] });

    rerender(
      <Thread
        thread={thread([comment({ body: "draft", draft: true })])}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByRole("button", { name: /Archive/ })).toBeDisabled();
  });

  it("offers only Unarchive on an archived thread", async () => {
    const onChanged = vi.fn();
    render(
      <Thread
        thread={thread([comment({ body: "old" })], {
          archivedAt: "2026-09-24T10:00:00Z",
          archivedHead: "abc1234",
        })}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reply/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Resolve/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Unarchive/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.unarchiveThread).toHaveBeenCalledWith(1);
  });

  describe("folding", () => {
    const t = thread([
      comment({ body: "why this loop?" }),
      comment({ authorRole: "agent", body: "because of batching" }),
    ]);

    it("folds to one line with the first comment, and remembers it", () => {
      const { unmount } = render(<Thread thread={t} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Fold the thread" }));
      const card = screen.getByTestId("thread-1");
      expect(card).toHaveTextContent("why this loop?");
      expect(card).not.toHaveTextContent("because of batching");
      expect(screen.queryAllByTestId(/comment-/)).toHaveLength(0);

      unmount();
      render(<Thread thread={t} onChanged={() => {}} />);
      expect(screen.queryAllByTestId(/comment-/)).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Open the thread" }));
      expect(screen.getAllByTestId(/comment-/)).toHaveLength(2);
    });

    it("starts a resolved thread folded, unless it holds a draft", () => {
      const { unmount } = render(
        <Thread thread={{ ...t, resolved: true }} onChanged={() => {}} />,
      );
      expect(screen.getByTestId("thread-1")).toHaveAttribute("data-folded");
      unmount();
      render(
        <Thread
          thread={{
            ...t,
            resolved: true,
            comments: [...t.comments, comment({ id: 9, draft: true })],
          }}
          onChanged={() => {}}
        />,
      );
      expect(screen.getByTestId("thread-1")).not.toHaveAttribute("data-folded");
    });

    it("folds on resolve even after a jump opened it", async () => {
      const { rerender } = render(
        <FocusedThreadContext.Provider value={1}>
          <Thread thread={t} onChanged={() => {}} />
        </FocusedThreadContext.Provider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
      await waitFor(() =>
        expect(screen.getByTestId("thread-1")).toHaveAttribute("data-folded"),
      );
      rerender(
        <FocusedThreadContext.Provider value={1}>
          <Thread thread={{ ...t, resolved: true }} onChanged={() => {}} />
        </FocusedThreadContext.Provider>,
      );
      expect(screen.getByTestId("thread-1")).toHaveAttribute("data-folded");
    });

    it("opens a folded thread a jump lands on", () => {
      render(
        <FocusedThreadContext.Provider value={1}>
          <Thread thread={{ ...t, resolved: true }} onChanged={() => {}} />
        </FocusedThreadContext.Provider>,
      );
      expect(screen.getAllByTestId(/comment-/)).toHaveLength(2);
    });
  });

  describe("minimizing", () => {
    it("minimizes a comment to its author, and remembers it", () => {
      const t = thread([
        comment({ id: 1, body: "why this loop?" }),
        comment({ id: 2, authorRole: "agent", body: "because of batching" }),
      ]);
      const { unmount } = render(<Thread thread={t} onChanged={() => {}} />);
      const reply = screen.getByTestId("comment-2");
      fireEvent.click(
        within(reply).getByRole("button", { name: "Minimize the comment" }),
      );
      expect(screen.getByTestId("comment-2")).toHaveAttribute("data-minimized");
      expect(screen.getByTestId("comment-2")).toHaveTextContent("agent");
      expect(screen.getByTestId("comment-2")).not.toHaveTextContent(
        "because of batching",
      );
      expect(screen.getByTestId("comment-1")).toHaveTextContent(
        "why this loop?",
      );

      unmount();
      render(<Thread thread={t} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Show" }));
      expect(screen.getByTestId("comment-2")).toHaveTextContent(
        "because of batching",
      );
    });

    it("never minimizes a draft", () => {
      render(
        <Thread
          thread={thread([comment({ id: 3, body: "wip", draft: true })])}
          onChanged={() => {}}
        />,
      );
      expect(
        screen.queryByRole("button", { name: "Minimize the comment" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("a link to one comment", () => {
    it("outlines that comment, not the card, and shows it if minimized", () => {
      Element.prototype.scrollIntoView = vi.fn();
      const t = thread([
        comment({ id: 1, body: "why this loop?" }),
        comment({ id: 2, authorRole: "agent", body: "because of batching" }),
      ]);
      const { unmount } = render(<Thread thread={t} onChanged={() => {}} />);
      fireEvent.click(
        within(screen.getByTestId("comment-2")).getByRole("button", {
          name: "Minimize the comment",
        }),
      );
      unmount();

      render(
        <FocusedThreadContext.Provider value={1}>
          <FocusedCommentContext.Provider value={2}>
            <Thread thread={t} onChanged={() => {}} />
          </FocusedCommentContext.Provider>
        </FocusedThreadContext.Provider>,
      );
      const reply = screen.getByTestId("comment-2");
      expect(reply).toHaveAttribute("data-focused");
      expect(reply).toHaveTextContent("because of batching");
      expect(screen.getByTestId("thread-1").className).not.toMatch(
        /outline-primary/,
      );
    });
  });
});
