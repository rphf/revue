import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import type { AnnotationMeta } from "../components/DiffView";
import type { Comment, Thread } from "../types";

// Mock the diff renderer but keep the annotation wiring real: the
// stub FileDiff invokes renderAnnotation for every annotation, so
// threads flow through the same path as in the browser.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({
    fileDiff,
    lineAnnotations,
    renderAnnotation,
  }: {
    fileDiff: FileDiffMetadata;
    lineAnnotations?: DiffLineAnnotation<AnnotationMeta>[];
    renderAnnotation?: (a: DiffLineAnnotation<AnnotationMeta>) => React.ReactNode;
  }) => (
    <div data-testid={`filediff-${fileDiff.name}`}>
      {lineAnnotations?.map((a, i) => (
        <div key={i} data-testid={`annotation-${fileDiff.name}-${a.lineNumber}`}>
          {renderAnnotation?.(a)}
        </div>
      ))}
    </div>
  ),
  Virtualizer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: () => [{ files: [{ name: "a.go" }] }],
}));

vi.mock("../api", () => ({
  api: {
    getReview: vi.fn(),
    listThreads: vi.fn(),
    getRound: vi.fn(),
    getPatch: vi.fn(),
    createThread: vi.fn(),
    reply: vi.fn(),
    editComment: vi.fn(),
    deleteComment: vi.fn(),
    resolveThread: vi.fn(),
    submit: vi.fn(),
    close: vi.fn(),
    reopen: vi.fn(),
    createRound: vi.fn(),
  },
}));

import { api } from "../api";
import ReviewPage from "./ReviewPage";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {}
}

const ROUND_ID = 20;

function makeThread(comments: Comment[]): Thread {
  return {
    id: 1,
    reviewId: 1,
    originRoundId: ROUND_ID,
    resolved: false,
    createdAt: "",
    originRoundSeq: 1,
    anchors: [
      { id: 1, threadId: 1, roundId: ROUND_ID, path: "a.go", side: "additions", line: 5, state: "live" },
    ],
    comments,
  };
}

const reviewerComment: Comment = {
  id: 100,
  threadId: 1,
  authorRole: "reviewer",
  body: "please rename this",
  draft: false,
  createdAt: "",
};

const agentReply: Comment = {
  id: 101,
  threadId: 1,
  authorRole: "agent",
  body: "renamed in the next round",
  draft: false,
  createdAt: "",
};

describe("ReviewPage live updates (AE4 UI half)", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);

    vi.mocked(api.getReview).mockResolvedValue({
      review: {
        id: 1,
        repoRoot: "/repo",
        branch: "main",
        sourceArgs: [],
        state: "open",
        createdAt: "",
        updatedAt: "",
      },
      rounds: [{ seq: 1, createdAt: "" }],
      submissions: [],
    });
    vi.mocked(api.getRound).mockResolvedValue({
      round: { id: ROUND_ID, reviewId: 1, seq: 1, patch: "x", createdAt: "" },
      files: [{ id: 1, roundId: ROUND_ID, path: "a.go", status: "modified", isBinary: false }],
      anchors: [],
    });
    vi.mocked(api.getPatch).mockResolvedValue("diff --git a/a.go b/a.go\n");
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [makeThread([reviewerComment])] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows an agent reply arriving over SSE without any reload", async () => {
    render(<ReviewPage reviewId={1} theme="light" onToggleTheme={() => {}} onNavigate={() => {}} />);

    // Initial thread renders inline at its anchor.
    await waitFor(() => expect(screen.getByText("please rename this")).toBeInTheDocument());
    expect(screen.queryByText("renamed in the next round")).not.toBeInTheDocument();

    // The agent replies; the server pushes a thread.replied event.
    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [makeThread([reviewerComment, agentReply])],
    });
    const es = FakeEventSource.instances[0];
    act(() => {
      es.onmessage?.({
        data: JSON.stringify({ id: 9, reviewId: 1, type: "thread.replied", payload: {}, createdAt: "" }),
      });
    });

    // The reply appears with its author role — no reload, no clicks.
    await waitFor(() => expect(screen.getByText("renamed in the next round")).toBeInTheDocument());
    expect(screen.getByTestId("thread-1")).toHaveTextContent("agent");
    // And it did not resolve the thread (AE4): resolve is still offered.
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
  });
});
