import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { RoundFile } from "../types";

// The real @pierre/diffs renderer needs Shadow DOM + workers; mock the
// react entry so tests exercise revue's wiring, not the library.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: FileDiffMetadata }) => (
    <div data-testid={`filediff-${fileDiff.name}`}>{fileDiff.name}</div>
  ),
  Virtualizer: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import DiffView from "./DiffView";

function meta(name: string): FileDiffMetadata {
  return { name } as FileDiffMetadata;
}

let nextId = 1;
function roundFile(path: string, extra: Partial<RoundFile> = {}): RoundFile {
  return { id: nextId++, roundId: 1, path, status: "modified", isBinary: false, ...extra };
}

describe("DiffView", () => {
  it("renders one FileDiff per parsed text file", () => {
    render(
      <DiffView
        files={[meta("a.go"), meta("b.go")]}
        roundFiles={[roundFile("a.go"), roundFile("b.go")]}
        diffStyle="unified"
        theme="light"
      />,
    );
    expect(screen.getByTestId("filediff-a.go")).toBeInTheDocument();
    expect(screen.getByTestId("filediff-b.go")).toBeInTheDocument();
  });

  it("renders binary files as stat-only rows, never as FileDiff (R24)", () => {
    render(
      <DiffView
        files={[meta("img.png"), meta("code.go")]}
        roundFiles={[roundFile("img.png", { isBinary: true, status: "added" }), roundFile("code.go")]}
        diffStyle="unified"
        theme="light"
      />,
    );
    expect(screen.getByTestId("binary-img.png")).toHaveTextContent("Binary file (added)");
    expect(screen.queryByTestId("filediff-img.png")).not.toBeInTheDocument();
    expect(screen.getByTestId("filediff-code.go")).toBeInTheDocument();
  });

  it("renders the empty state for an empty diff", () => {
    render(<DiffView files={[]} roundFiles={[]} diffStyle="unified" theme="light" />);
    expect(screen.getByTestId("diff-empty")).toHaveTextContent("No changes in this diff");
  });
});
