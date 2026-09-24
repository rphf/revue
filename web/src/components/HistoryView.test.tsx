import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { History } from "../types";
import { comment, thread } from "../test/fixtures";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: { getHistory: vi.fn() },
}));

import { api } from "../api";
import HistoryView from "./HistoryView";

const fix = "f".repeat(40);
const quiet = "a".repeat(40);
const rewritten = "b".repeat(40);

function history(h: Partial<History> = {}): History {
  return {
    branch: "feat",
    current: "feat",
    branches: [
      { name: "feat", threads: 2 },
      { name: "older", threads: 1 },
    ],
    commits: [
      {
        hash: fix,
        subject: "the fix",
        date: "2026-09-24T10:00:00Z",
        onBranch: true,
        threads: [
          thread([comment({ body: "rename this" })], { id: 7, resolved: true }),
          thread([comment({ body: "still open" })], { id: 8 }),
        ],
      },
      {
        hash: quiet,
        subject: "quiet commit",
        date: "2026-09-23T10:00:00Z",
        onBranch: true,
        threads: [],
      },
      {
        hash: rewritten,
        subject: "before the rebase",
        date: "2026-09-22T10:00:00Z",
        onBranch: false,
        threads: [thread([comment({ body: "old one" })], { id: 9 })],
      },
    ],
    more: false,
    ...h,
  };
}

describe("HistoryView", () => {
  afterEach(() => vi.clearAllMocks());

  it("lists the branch's commits with the threads that landed in each", async () => {
    vi.mocked(api.getHistory).mockResolvedValue(history());
    const onOpen = vi.fn();
    render(<HistoryView branch="feat" onOpen={onOpen} signal={0} />);

    const fixRow = await screen.findByTestId("history-commit-fffffff");
    expect(fixRow).toHaveTextContent("the fix");
    expect(screen.getByTestId("history-thread-7")).not.toHaveTextContent(
      "unresolved",
    );
    expect(screen.getByTestId("history-thread-8")).toHaveTextContent(
      "unresolved",
    );
    expect(screen.getByTestId("history-commit-aaaaaaa")).toHaveTextContent(
      "quiet commit",
    );
    expect(screen.getByTestId("history-commit-bbbbbbb")).toHaveTextContent(
      "rewritten",
    );

    fireEvent.click(screen.getByTestId("history-thread-8"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }));
  });

  it("loads older commits for its branch", async () => {
    vi.mocked(api.getHistory).mockResolvedValue(history({ more: true }));
    render(<HistoryView branch="feat" onOpen={() => {}} signal={0} />);
    await screen.findByTestId("history-commit-fffffff");
    expect(api.getHistory).toHaveBeenLastCalledWith("feat", 200);
    fireEvent.click(screen.getByRole("button", { name: "Load older commits" }));
    await waitFor(() =>
      expect(api.getHistory).toHaveBeenLastCalledWith("feat", 400),
    );
  });

  it("says so when the branch has no archived thread yet", async () => {
    vi.mocked(api.getHistory).mockResolvedValue(
      history({
        commits: [
          {
            hash: quiet,
            subject: "quiet commit",
            date: "2026-09-23T10:00:00Z",
            onBranch: true,
            threads: [],
          },
        ],
      }),
    );
    render(<HistoryView branch="feat" onOpen={() => {}} signal={0} />);
    expect(
      await screen.findByText(/No archived threads on feat yet/),
    ).toBeInTheDocument();
  });
});
