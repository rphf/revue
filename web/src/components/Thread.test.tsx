import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    expect(screen.getByText("Resolved")).toBeInTheDocument();
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
});
