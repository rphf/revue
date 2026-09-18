import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Comment, Thread as ThreadType } from "../types";

vi.mock("../api", () => ({
  api: {
    reply: vi.fn(async () => ({})),
    editComment: vi.fn(async () => ({})),
    deleteComment: vi.fn(async () => {}),
    resolveThread: vi.fn(async () => ({})),
  },
}));

import { api } from "../api";
import Thread from "./Thread";

let nextId = 1;
function comment(
  role: Comment["authorRole"],
  body: string,
  draft = false,
): Comment {
  return {
    id: nextId++,
    threadId: 1,
    authorRole: role,
    body,
    draft,
    createdAt: "2026-07-03T10:00:00Z",
  };
}

function thread(comments: Comment[], resolved = false): ThreadType {
  return {
    id: 1,
    reviewId: 1,
    originRoundId: 10,
    resolved,
    createdAt: "",
    originRoundSeq: 1,
    anchors: [],
    comments,
  };
}

describe("Thread", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders replies in order with author roles", () => {
    const t = thread([
      comment("reviewer", "first: why this loop?"),
      comment("agent", "second: because of batching"),
      comment("reviewer", "third: fair enough"),
    ]);
    render(<Thread thread={t} reviewState="open" onChanged={() => {}} />);

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
      comment(
        "agent",
        'before <script>window.__pwned = true</script> <img src=x onerror="window.__pwned=true"> after',
      ),
    ]);
    render(<Thread thread={t} reviewState="open" onChanged={() => {}} />);
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
    const draft = comment("reviewer", "draft body", true);
    const t = thread([draft]);
    render(<Thread thread={t} reviewState="open" onChanged={onChanged} />);

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
    const t = thread([comment("reviewer", "published", false)]);
    render(<Thread thread={t} reviewState="open" onChanged={() => {}} />);
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });

  it("replies through the api", async () => {
    const t = thread([comment("reviewer", "question")]);
    render(<Thread thread={t} reviewState="open" onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "an answer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(api.reply).toHaveBeenCalledWith(1, "an answer"));
  });

  it("resolves and unresolves", async () => {
    const t = thread([comment("reviewer", "x")]);
    const { rerender } = render(
      <Thread thread={t} reviewState="open" onChanged={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(api.resolveThread).toHaveBeenCalledWith(1, true),
    );

    rerender(
      <Thread
        thread={thread([comment("reviewer", "x")], true)}
        reviewState="open"
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unresolve" }));
    await waitFor(() =>
      expect(api.resolveThread).toHaveBeenCalledWith(1, false),
    );
  });

  it("links outdated threads to their origin round", () => {
    const jump = vi.fn();
    const t = thread([comment("reviewer", "old context")]);
    render(
      <Thread
        thread={t}
        anchorState="outdated"
        reviewState="open"
        onChanged={() => {}}
        onJumpToOrigin={jump}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Outdated · round 1/ }));
    expect(jump).toHaveBeenCalledWith(1);
  });
});
