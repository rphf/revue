import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoundDetail, Thread } from "../types";

// Round switching and origin-round links (R8, R22 UI). The diff
// renderer is mocked; parsePatchFiles derives the file name from the
// patch text so each round renders distinguishable content.
interface StubItem {
  id: string;
  type: "diff" | "file";
  annotations?: { lineNumber: number }[];
}
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({
    items,
    renderAnnotation,
  }: {
    items: StubItem[];
    renderAnnotation?: (a: unknown, item: StubItem) => React.ReactNode;
  }) => (
    <div>
      {items.map((item) => (
        <div key={item.id} data-testid={`filediff-${item.id}`}>
          {item.id}
          {item.annotations?.map((a, i) => (
            <div key={i}>{renderAnnotation?.(a, item)}</div>
          ))}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: (patch: string) => [
    { files: [{ name: patch.includes("ROUND2") ? "round2.go" : "round1.go" }] },
  ],
  processFile: () => undefined,
}));

vi.mock("../api", () => ({
  api: {
    getReview: vi.fn(),
    listThreads: vi.fn(),
    getRound: vi.fn(),
    getPatch: vi.fn(),
    getFileVersions: vi.fn(() => new Promise(() => {})),
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
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

const ROUND1_ID = 10;
const ROUND2_ID = 20;

function roundDetail(seq: number): RoundDetail {
  const id = seq === 1 ? ROUND1_ID : ROUND2_ID;
  return {
    round: { id, reviewId: 1, seq, patch: "", createdAt: "" },
    files: [{ id, roundId: id, path: `round${seq}.go`, status: "modified", isBinary: false }],
    anchors: [],
  };
}

// A thread born in round 1 whose hunk was rewritten: live at round 1,
// outdated at round 2.
const outdatedThread: Thread = {
  id: 7,
  reviewId: 1,
  originRoundId: ROUND1_ID,
  resolved: false,
  createdAt: "",
  originRoundSeq: 1,
  anchors: [
    { id: 1, threadId: 7, roundId: ROUND1_ID, path: "round1.go", side: "additions", line: 4, state: "live" },
    { id: 2, threadId: 7, roundId: ROUND2_ID, path: "round1.go", side: "additions", line: 4, state: "outdated" },
  ],
  comments: [{ id: 70, threadId: 7, authorRole: "reviewer", body: "old context note", draft: false, createdAt: "" }],
};

describe("round history (R8, R22)", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(api.getReview).mockResolvedValue({
      review: { id: 1, repoRoot: "/r", branch: "main", sourceArgs: [], state: "open", createdAt: "", updatedAt: "" },
      rounds: [
        { seq: 1, createdAt: "" },
        { seq: 2, createdAt: "" },
      ],
      submissions: [],
    });
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [outdatedThread] });
    vi.mocked(api.getRound).mockImplementation(async (_id, seq) => roundDetail(seq));
    vi.mocked(api.getPatch).mockImplementation(async (_id, seq) =>
      seq === 2 ? "diff ROUND2 content" : "diff ROUND1 content",
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function renderPage() {
    return render(<ReviewPage reviewId={1} theme="light" onToggleTheme={() => {}} onNavigate={() => {}} />);
  }

  it("shows the latest round by default and swaps patch content on switch", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("filediff-round2.go")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Previous round" }));
    await waitFor(() => expect(screen.getByTestId("filediff-round1.go")).toBeInTheDocument());
    expect(screen.queryByTestId("filediff-round2.go")).not.toBeInTheDocument();
    expect(api.getPatch).toHaveBeenLastCalledWith(1, 1);
    expect(screen.getByText("viewing a past round")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next round" }));
    await waitFor(() => expect(screen.getByTestId("filediff-round2.go")).toBeInTheDocument());
    expect(screen.queryByText("viewing a past round")).not.toBeInTheDocument();
  });

  it("shows the loading skeleton while a round fetch is in flight and disables the switcher", async () => {
    let resolvePatch!: (p: string) => void;
    renderPage();
    await waitFor(() => expect(screen.getByTestId("filediff-round2.go")).toBeInTheDocument());

    vi.mocked(api.getPatch).mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolvePatch = resolve)),
    );
    vi.mocked(api.getRound).mockImplementationOnce(
      () => new Promise<RoundDetail>(() => {}), // round metadata still loading
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous round" }));

    expect(screen.getByTestId("diff-loading")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Round" })).toBeDisabled();
    resolvePatch("diff ROUND1 content");
  });

  it("jumps to the originating round when an outdated panel thread is clicked", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("filediff-round2.go")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /threads/ }));
    fireEvent.click(await screen.findByTestId("panel-thread-7"));

    // The origin round's frozen snapshot renders, where the thread is
    // still live at its original anchor.
    await waitFor(() => expect(screen.getByTestId("filediff-round1.go")).toBeInTheDocument());
    expect(api.getPatch).toHaveBeenLastCalledWith(1, 1);
    await waitFor(() => expect(screen.getByText("old context note")).toBeInTheDocument());
  });

  it("surfaces round fetch errors inline with a retry that recovers", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("filediff-round2.go")).toBeInTheDocument());

    vi.mocked(api.getPatch).mockRejectedValueOnce(new Error("connection refused"));
    fireEvent.click(screen.getByRole("button", { name: "Previous round" }));

    await waitFor(() => expect(screen.getByTestId("diff-error")).toHaveTextContent("connection refused"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("filediff-round1.go")).toBeInTheDocument());
  });
});
