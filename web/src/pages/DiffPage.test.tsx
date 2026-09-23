import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLineAnnotation } from "@pierre/diffs";
import type { AnnotationMeta } from "../components/DiffView";
import type { DiffResponse, Thread } from "../types";
import { comment, FakeEventSource, thread } from "../test/fixtures";

// Mock the diff renderer but keep the annotation wiring real: the
// stub CodeView invokes renderAnnotation for every item annotation,
// so threads flow through the same path as in the browser. Annotation
// containers are keyed by item version, so a changed file remounts
// them the way the real virtualizer does. Like the real one, the stub
// keeps an item it has seen until its version changes. Each scrollTo is
// recorded with whether its item was collapsed at that moment, and so
// is each clearing of the line selection.
interface StubItem {
  id: string;
  type: "diff" | "file";
  version?: number;
  collapsed?: boolean;
  annotations?: DiffLineAnnotation<AnnotationMeta>[];
}
const scrolls: { id: string; type: string; collapsed?: boolean }[] = [];
const selectionClears: number[] = [];
interface StubOptions {
  onGutterUtilityClick?: (
    range: { start: number; end: number; side: string },
    context: { item: { id: string; type: string } },
  ) => void;
}
vi.mock("@pierre/diffs/react", async () => {
  const { useImperativeHandle, useRef } = await import("react");
  const CodeView = ({
    ref,
    items: next,
    options,
    renderAnnotation,
    renderHeaderPrefix,
    renderHeaderMetadata,
  }: {
    ref?: React.Ref<unknown>;
    items: StubItem[];
    options: StubOptions;
    renderAnnotation?: (
      a: DiffLineAnnotation<AnnotationMeta>,
      item: StubItem,
    ) => React.ReactNode;
    renderHeaderPrefix?: (item: StubItem) => React.ReactNode;
    renderHeaderMetadata?: (item: StubItem) => React.ReactNode;
  }) => {
    const seen = useRef(new Map<string, StubItem>());
    const items = next.map((item) => {
      const prev = seen.current.get(item.id);
      if (prev && prev.version === item.version) return prev;
      seen.current.set(item.id, item);
      return item;
    });
    useImperativeHandle(ref, () => ({
      scrollTo: (t: { id: string; type: string }) =>
        scrolls.push({ ...t, collapsed: seen.current.get(t.id)?.collapsed }),
      clearSelectedLines: () => selectionClears.push(1),
      getInstance: () => null,
    }));
    return (
      <div>
        <button
          type="button"
          onClick={() =>
            options.onGutterUtilityClick?.(
              { start: 5, end: 5, side: "additions" },
              { item: { id: "a.go", type: "diff" } },
            )
          }
        >
          select-line
        </button>
        {items.map((item) => (
          <div
            key={`${item.id}:${item.version ?? 0}`}
            data-testid={`filediff-${item.id}`}
            data-collapsed={item.collapsed ? "true" : undefined}
          >
            {renderHeaderPrefix?.(item)}
            {renderHeaderMetadata?.(item)}
            {item.annotations?.map((a, i) => (
              <div
                key={i}
                data-testid={`annotation-${item.id}-${a.lineNumber}`}
              >
                {renderAnnotation?.(a, item)}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };
  return { CodeView };
});

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: () => [{ files: [{ name: "a.go", hunks: [] }] }],
  processFile: () => undefined,
  parseDiffFromFile: () => ({ name: "a.go" }),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: {
    getDiff: vi.fn(),
    listThreads: vi.fn(),
    listSends: vi.fn(() => Promise.resolve({ sends: [] })),
    getDiffFile: vi.fn(() => new Promise(() => {})),
    getSnapshot: vi.fn(),
    assetUrl: (path: string) => `/api/asset?path=${path}`,
    createThread: vi.fn(),
    reply: vi.fn(),
    editComment: vi.fn(),
    deleteComment: vi.fn(),
    resolveThread: vi.fn(),
    send: vi.fn(),
  },
}));

import { api } from "../api";
import DiffPage from "./DiffPage";

function pushEvent(data: unknown) {
  act(() => FakeEventSource.latest().emit(data));
}

// Thread 1, with its comments.
const makeThread = (comments: Parameters<typeof thread>[0]) =>
  thread(comments, { createdAt: "2026-09-20T10:00:00Z" });

// A promise the test settles by hand.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeDiff(
  version: number,
  state: "live" | "outdated" = "live",
  patch = "diff --git a/a.go b/a.go\n+one\n",
): DiffResponse {
  return {
    args: [],
    branch: "main",
    repo: "repo",
    version,
    patch,
    files: [{ path: "a.go", status: "modified", isBinary: false }],
    anchors: [{ threadId: 1, path: "a.go", side: "additions", line: 5, state }],
  };
}

const reviewerComment = comment({
  id: 100,
  body: "please rename this",
  createdAt: "",
});

const agentReply = comment({
  id: 101,
  authorRole: "agent",
  body: "renamed it",
  createdAt: "",
});

function renderPage() {
  return render(
    <DiffPage
      args={[]}
      theme="light"
      onToggleTheme={() => {}}
      onNavigate={() => {}}
    />,
  );
}

describe("DiffPage send", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(api.getDiff).mockResolvedValue(makeDiff(1));
    vi.mocked(api.send).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends the drafts in one click from the top bar", async () => {
    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [makeThread([{ ...reviewerComment, draft: true }])],
    });
    renderPage();
    const sendNow = await screen.findByTestId("send-now");
    await waitFor(() => expect(sendNow).toHaveTextContent("1"));
    fireEvent.click(sendNow);
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(""));
    expect(screen.queryByTestId("send-composer")).not.toBeInTheDocument();
  });

  it("opens the composer from Send when there are no drafts, without sending", async () => {
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [] });
    renderPage();
    fireEvent.click(await screen.findByTestId("send-now"));
    expect(await screen.findByTestId("send-composer")).toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
  });

  it("opens the threads panel on the composer to send with a note", async () => {
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [] });
    renderPage();
    fireEvent.click(await screen.findByTestId("open-send"));
    const note = await screen.findByLabelText("Note to the agent");
    expect(screen.getByTestId("threads-panel")).toBeInTheDocument();
    await waitFor(() => expect(note).toHaveFocus());
    fireEvent.change(note, { target: { value: "LGTM" } });
    fireEvent.keyDown(note, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("LGTM"));
    await waitFor(() => expect(note).toHaveValue(""));
  });
});

describe("DiffPage live updates", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(api.getDiff).mockResolvedValue(makeDiff(1));
    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [makeThread([reviewerComment])],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("names the repository in the top bar and the tab title", async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId("repo-name")).toHaveTextContent("repo"),
    );
    expect(document.title).toBe("repo · revue");
  });

  it("shows an agent reply arriving over SSE without any reload", async () => {
    renderPage();

    // Initial thread renders inline at its live position.
    await waitFor(() =>
      expect(screen.getByText("please rename this")).toBeInTheDocument(),
    );
    expect(screen.queryByText("renamed it")).not.toBeInTheDocument();

    // The agent replies; the server pushes a thread.replied event.
    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [makeThread([reviewerComment, agentReply])],
    });
    pushEvent({ id: 9, type: "thread.replied", payload: {}, createdAt: "" });

    // The reply appears with its author role: no reload, no clicks.
    await waitFor(() =>
      expect(screen.getByText("renamed it")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("thread-1")).toHaveTextContent("agent");
    // And it did not resolve the thread: resolve is still offered.
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
  });

  it("refetches the diff only for a new version and keeps the pending comment text", async () => {
    renderPage();
    await waitFor(() => expect(api.getDiff).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("filediff-a.go")).toBeInTheDocument(),
    );

    // Start a comment and type into it.
    fireEvent.click(screen.getByRole("button", { name: "select-line" }));
    const box = await screen.findByPlaceholderText("Comment on line 5");
    fireEvent.change(box, { target: { value: "keep me" } });

    // The version on screen: nothing to fetch.
    pushEvent({ type: "diff.changed", payload: { version: 1 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getDiff).toHaveBeenCalledTimes(1);

    // A new version with a changed file: refetch, remount, text kept.
    vi.mocked(api.getDiff).mockResolvedValue(
      makeDiff(2, "live", "diff --git a/a.go b/a.go\n+two\n"),
    );
    pushEvent({ type: "diff.changed", payload: { version: 2 } });
    await waitFor(() => expect(api.getDiff).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Comment on line 5")).toHaveValue(
        "keep me",
      ),
    );
  });

  it("outlines a live thread jumped to from the panel", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("please rename this")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(await screen.findByTestId("panel-thread-1"));
    expect(screen.getByTestId("thread-1")).toHaveAttribute("data-focused");
    expect(screen.queryByTestId("snapshot-view")).not.toBeInTheDocument();

    // A click inside the thread keeps it; one outside drops it.
    fireEvent.pointerDown(screen.getByTestId("comment-100"));
    expect(screen.getByTestId("thread-1")).toHaveAttribute("data-focused");
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId("thread-1")).not.toHaveAttribute("data-focused");
  });

  it("opens an outdated thread on its snapshot from the threads panel", async () => {
    vi.mocked(api.getDiff).mockResolvedValue(makeDiff(1, "outdated"));
    vi.mocked(api.getSnapshot).mockResolvedValue({
      path: "a.go",
      status: "modified",
      oldContent: "old\n",
      newContent: "new\n",
      createdAt: "2026-09-20T10:00:00Z",
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("filediff-a.go")).toBeInTheDocument(),
    );
    // Outdated: not inline.
    expect(screen.queryByText("please rename this")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    const row = await screen.findByTestId("panel-thread-1");
    expect(row).toHaveTextContent(/outdated/);
    fireEvent.click(row);

    const view = await screen.findByTestId("snapshot-view");
    expect(view).toHaveTextContent("As it was when the thread started");
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledWith(1));
    // The thread renders on the snapshot, with its actions, outlined.
    await waitFor(() => expect(view).toHaveTextContent("please rename this"));
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
    expect(screen.getByTestId("thread-1")).toHaveAttribute("data-focused");
    // The panel stays open beside it, the row marked.
    expect(screen.getByTestId("panel-thread-1")).toHaveAttribute(
      "aria-current",
      "true",
    );

    // A click elsewhere drops the outline; Escape goes back to the diff.
    fireEvent.pointerDown(view);
    expect(screen.getByTestId("thread-1")).not.toHaveAttribute("data-focused");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("snapshot-view")).not.toBeInTheDocument();
  });

  it("shows a reply sent from the snapshot without reopening it", async () => {
    vi.mocked(api.getDiff).mockResolvedValue(makeDiff(1, "outdated"));
    vi.mocked(api.getSnapshot).mockResolvedValue({
      path: "a.go",
      status: "modified",
      oldContent: "old\n",
      newContent: "new\n",
      createdAt: "2026-09-20T10:00:00Z",
    });
    vi.mocked(api.reply).mockResolvedValue(undefined as never);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("filediff-a.go")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(await screen.findByTestId("panel-thread-1"));
    await waitFor(() =>
      expect(screen.getByTestId("snapshot-view")).toHaveTextContent(
        "please rename this",
      ),
    );

    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [
        makeThread([
          reviewerComment,
          { ...reviewerComment, id: 102, body: "one more thing", draft: true },
        ]),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByPlaceholderText("Reply"), {
      target: { value: "one more thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    await waitFor(() =>
      expect(api.reply).toHaveBeenCalledWith(1, "one more thing"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("snapshot-view")).toHaveTextContent(
        "one more thing",
      ),
    );
    expect(screen.getByTestId("comment-102")).toBeInTheDocument();
  });

  it("steps through outdated threads without leaving the snapshot", async () => {
    const second: Thread = {
      ...makeThread([{ ...reviewerComment, id: 200, body: "second one" }]),
      id: 2,
      line: 9,
    };
    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [makeThread([reviewerComment]), second],
    });
    const diff = makeDiff(1, "outdated");
    diff.anchors.push({ ...diff.anchors[0], threadId: 2, line: 9 });
    vi.mocked(api.getDiff).mockResolvedValue(diff);
    vi.mocked(api.getSnapshot).mockResolvedValue({
      path: "a.go",
      status: "modified",
      oldContent: "old\n",
      newContent: "new\n",
      createdAt: "2026-09-20T10:00:00Z",
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("filediff-a.go")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(await screen.findByTestId("panel-thread-1"));

    await screen.findByTestId("snapshot-view");
    expect(screen.getByTestId("snapshot-position")).toHaveTextContent(
      "1 of 2 outdated",
    );
    expect(
      screen.getByRole("button", { name: "Previous outdated thread" }),
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", { name: "Next outdated thread" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("snapshot-view")).toHaveTextContent(
        "second one",
      ),
    );
    expect(api.getSnapshot).toHaveBeenLastCalledWith(2);
    expect(screen.getByTestId("snapshot-position")).toHaveTextContent(
      "2 of 2 outdated",
    );
    expect(screen.getByTestId("thread-2")).toHaveAttribute("data-focused");

    // The keyboard goes back, but not while typing.
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() =>
      expect(screen.getByTestId("snapshot-view")).toHaveTextContent(
        "please rename this",
      ),
    );
  });
});

describe("DiffPage refreshes", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(api.getDiff).mockResolvedValue(makeDiff(1));
    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [makeThread([reviewerComment])],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

  it("folds a burst of thread events into one more fetch", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("please rename this")).toBeInTheDocument(),
    );
    expect(api.listThreads).toHaveBeenCalledTimes(1);

    act(() => {
      for (let id = 1; id <= 5; id++)
        FakeEventSource.latest().emit({ id, type: "thread.replied" });
    });
    await settle();
    // One fetch for the first event, one for everything after it.
    expect(api.listThreads).toHaveBeenCalledTimes(3);
  });

  it("ends a burst on the answer to the last fetch", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("please rename this")).toBeInTheDocument(),
    );
    const first = deferred<{ threads: Thread[] }>();
    vi.mocked(api.listThreads)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        threads: [makeThread([reviewerComment, agentReply])],
      });
    pushEvent({ id: 1, type: "thread.replied" });
    pushEvent({ id: 2, type: "thread.replied" });
    // The overtaken answer never shows.
    await act(async () => first.resolve({ threads: [] }));
    expect(screen.getByText("please rename this")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("renamed it")).toBeInTheDocument(),
    );
    expect(api.listThreads).toHaveBeenCalledTimes(3);
  });

  it("leaves a diff.changed notice to the first fetch still in flight", async () => {
    const initial = deferred<DiffResponse>();
    vi.mocked(api.getDiff).mockReturnValueOnce(initial.promise);
    renderPage();
    pushEvent({ type: "diff.changed", payload: { version: 1 } });
    await settle();
    expect(api.getDiff).toHaveBeenCalledTimes(1);

    await act(async () => initial.resolve(makeDiff(1)));
    await waitFor(() =>
      expect(screen.getByTestId("filediff-a.go")).toBeInTheDocument(),
    );
    await settle();
    expect(api.getDiff).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId("live-dot").querySelector(".live-pulse"),
    ).toBeNull();
  });

  it("refetches once the first fetch lands older than a notice", async () => {
    const initial = deferred<DiffResponse>();
    vi.mocked(api.getDiff).mockReturnValueOnce(initial.promise);
    vi.mocked(api.getDiff).mockResolvedValue(makeDiff(2));
    renderPage();
    pushEvent({ type: "diff.changed", payload: { version: 2 } });
    await act(async () => initial.resolve(makeDiff(1)));
    await waitFor(() => expect(api.getDiff).toHaveBeenCalledTimes(2));
  });

  it("pulses and refetches for a new version once a diff is on screen", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("filediff-a.go")).toBeInTheDocument(),
    );
    vi.mocked(api.getDiff).mockResolvedValue(makeDiff(2));
    pushEvent({ type: "diff.changed", payload: { version: 2 } });
    await waitFor(() => expect(api.getDiff).toHaveBeenCalledTimes(2));
    expect(
      screen.getByTestId("live-dot").querySelector(".live-pulse"),
    ).not.toBeNull();
  });
});

describe("DiffPage pending comment", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(api.getDiff).mockResolvedValue(makeDiff(1));
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("clears the line selection when the form is cancelled", async () => {
    selectionClears.length = 0;
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "select-line" }));
    await screen.findByPlaceholderText("Comment on line 5");
    expect(selectionClears).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByPlaceholderText("Comment on line 5"),
    ).not.toBeInTheDocument();
    expect(selectionClears).toHaveLength(1);
  });

  it("starts a thread without refetching the diff, placed at its line", async () => {
    selectionClears.length = 0;
    vi.mocked(api.createThread).mockResolvedValue(undefined as never);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "select-line" }));
    const box = await screen.findByPlaceholderText("Comment on line 5");
    fireEvent.change(box, { target: { value: "new thread" } });
    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [
        {
          ...makeThread([{ ...reviewerComment, body: "new thread" }]),
          id: 7,
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));

    await waitFor(() =>
      expect(screen.getByText("new thread")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("annotation-a.go-5")).toHaveTextContent(
      "new thread",
    );
    expect(selectionClears).toHaveLength(1);
    expect(api.getDiff).toHaveBeenCalledTimes(1);
  });

  it("starts a thread on the whole file from its header", async () => {
    vi.mocked(api.createThread).mockResolvedValue(undefined as never);
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Comment on a.go" }),
    );
    const box = await screen.findByPlaceholderText("Comment on this file");
    expect(screen.getByTestId("annotation-a.go-0")).toContainElement(box);
    fireEvent.change(box, { target: { value: "about the file" } });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));

    await waitFor(() =>
      expect(api.createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "a.go",
          side: "additions",
          line: 0,
          body: "about the file",
        }),
      ),
    );
  });
});

describe("DiffPage viewed files", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    scrolls.length = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(api.getDiff).mockResolvedValue(makeDiff(1));
    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [makeThread([reviewerComment])],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("collapses a file ticked as viewed in its header, and a jump to a thread in it opens it", async () => {
    renderPage();
    const box = await screen.findByRole("checkbox", { name: "Viewed a.go" });
    expect(screen.getByTestId("filediff-a.go")).not.toHaveAttribute(
      "data-collapsed",
    );

    fireEvent.click(box);
    expect(screen.getByRole("checkbox", { name: "Viewed a.go" })).toBeChecked();
    expect(screen.getByTestId("filediff-a.go")).toHaveAttribute(
      "data-collapsed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(await screen.findByTestId("panel-thread-1"));
    await waitFor(() =>
      expect(screen.getByTestId("filediff-a.go")).not.toHaveAttribute(
        "data-collapsed",
      ),
    );
    expect(screen.getByRole("checkbox", { name: "Viewed a.go" })).toBeChecked();
    expect(scrolls.filter((s) => s.type === "line")).toEqual([
      expect.objectContaining({ id: "a.go", collapsed: false }),
    ]);

    // Unticking and ticking again collapses it once more.
    fireEvent.click(screen.getByRole("checkbox", { name: "Viewed a.go" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Viewed a.go" }));
    expect(screen.getByTestId("filediff-a.go")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
  });

  it("collapses and expands any file from the arrow in its header", async () => {
    renderPage();
    const card = () => screen.getByTestId("filediff-a.go");
    fireEvent.click(
      await screen.findByRole("button", { name: "Collapse a.go" }),
    );
    expect(card()).toHaveAttribute("data-collapsed", "true");
    expect(
      screen.getByRole("checkbox", { name: "Viewed a.go" }),
    ).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Expand a.go" }));
    expect(card()).not.toHaveAttribute("data-collapsed");

    // A viewed file opened from its arrow stays viewed; ticking the box
    // again follows the viewed state and collapses it.
    fireEvent.click(screen.getByRole("checkbox", { name: "Viewed a.go" }));
    expect(card()).toHaveAttribute("data-collapsed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Expand a.go" }));
    expect(card()).not.toHaveAttribute("data-collapsed");
    expect(screen.getByRole("checkbox", { name: "Viewed a.go" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Viewed a.go" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Viewed a.go" }));
    expect(card()).toHaveAttribute("data-collapsed", "true");
  });
});

describe("DiffPage focus notice", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(api.getDiff).mockResolvedValue(makeDiff(1));
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [] });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("asks for notifications when it cannot bring the tab forward", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal(
      "Notification",
      Object.assign(vi.fn(), { permission: "default", requestPermission }),
    );
    renderPage();
    await screen.findByRole("button", { name: "select-line" });

    pushEvent({ type: "focus", payload: null });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(requestPermission).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Allow" }),
      ).not.toBeInTheDocument(),
    );
    expect(api.listThreads).toHaveBeenCalledTimes(1);
  });

  it("raises a notification once permitted", async () => {
    const shown: string[] = [];
    vi.stubGlobal(
      "Notification",
      Object.assign(
        function (this: object, title: string) {
          shown.push(title);
        },
        { permission: "granted" },
      ),
    );
    renderPage();
    await screen.findByRole("button", { name: "select-line" });

    pushEvent({ type: "focus", payload: null });
    expect(shown).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});
