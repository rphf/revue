import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { RoundFile } from "../types";

// The real @pierre/diffs renderer needs Shadow DOM + workers; mock the
// react entry so tests exercise revue's wiring, not the library. The
// stub CodeView walks items in order and invokes the render callbacks
// the way the real one does.
interface StubItem {
  id: string;
  type: "diff" | "file";
  annotations?: unknown[];
}
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({
    items,
    renderAnnotation,
    renderHeaderMetadata,
    className,
  }: {
    items: StubItem[];
    renderAnnotation?: (a: unknown, item: StubItem) => React.ReactNode;
    renderHeaderMetadata?: (item: StubItem) => React.ReactNode;
    className?: string;
  }) => (
    <div className={className}>
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`${item.type === "diff" ? "filediff" : "fileitem"}-${item.id}`}
        >
          {item.id}
          {renderHeaderMetadata?.(item)}
          {item.annotations?.map((a, i) => (
            <div key={i}>{renderAnnotation?.(a, item)}</div>
          ))}
        </div>
      ))}
    </div>
  ),
}));

import DiffView from "./DiffView";

function meta(name: string): FileDiffMetadata {
  return { name } as FileDiffMetadata;
}

let nextId = 1;
function roundFile(path: string, extra: Partial<RoundFile> = {}): RoundFile {
  return {
    id: nextId++,
    roundId: 1,
    path,
    status: "modified",
    isBinary: false,
    ...extra,
  };
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
        roundFiles={[
          roundFile("img.png", { isBinary: true, status: "added" }),
          roundFile("code.go"),
        ]}
        diffStyle="unified"
        theme="light"
      />,
    );
    expect(screen.getByTestId("binary-img.png")).toHaveTextContent(
      "Binary file (added)",
    );
    expect(screen.queryByTestId("filediff-img.png")).not.toBeInTheDocument();
    expect(screen.getByTestId("filediff-code.go")).toBeInTheDocument();
  });

  it("renders the empty state for an empty diff", () => {
    render(
      <DiffView files={[]} roundFiles={[]} diffStyle="unified" theme="light" />,
    );
    expect(screen.getByTestId("diff-empty")).toHaveTextContent(
      "No changes in this diff",
    );
  });
});

describe("DiffView rich markdown", () => {
  it("offers the Source/Rich switch on markdown files only", () => {
    render(
      <DiffView
        files={[meta("README.md"), meta("main.go")]}
        roundFiles={[roundFile("README.md"), roundFile("main.go")]}
        diffStyle="unified"
        theme="light"
        onToggleRich={() => {}}
      />,
    );
    const readme = screen.getByTestId("filediff-README.md");
    expect(
      within(readme).getByRole("radio", { name: "Rich" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("filediff-main.go")).queryByRole("radio"),
    ).not.toBeInTheDocument();
  });

  it("renders a rich file as a captioned file item with the document annotation", () => {
    const doc = {
      rev: "r",
      status: "ready" as const,
      blocks: [{ change: "added" as const, html: "<p>Hello</p>" }],
    };
    render(
      <DiffView
        files={[meta("README.md")]}
        roundFiles={[roundFile("README.md")]}
        diffStyle="unified"
        theme="light"
        richByFile={new Map([["README.md", doc]])}
        onToggleRich={() => {}}
        renderAnnotation={(a) => <div>{a.metadata?.kind}</div>}
      />,
    );
    const item = screen.getByTestId("fileitem-rich:README.md");
    expect(item).toHaveTextContent("rich");
    expect(within(item).getByRole("radio", { name: "Rich" })).toHaveAttribute(
      "data-state",
      "on",
    );
    expect(screen.queryByTestId("filediff-README.md")).not.toBeInTheDocument();
  });
});

describe("DiffView ordering", () => {
  it("renders cards in tree order with binary rows interleaved", () => {
    render(
      <DiffView
        files={[meta("zz.go"), meta("src/a.go")]}
        roundFiles={[
          roundFile("zz.go"),
          roundFile("src/a.go"),
          roundFile("src/img.png", { isBinary: true, status: "added" }),
        ]}
        diffStyle="unified"
        theme="light"
      />,
    );
    const cards = [
      ...document.querySelectorAll(
        "[data-testid^='filediff-'], [data-testid^='binary-']",
      ),
    ];
    const order = cards.map((c) => c.getAttribute("data-testid"));
    // Tree order: src/ first (a.go then img.png), then root zz.go —
    // the binary row sits in place, not grouped first.
    expect(order).toEqual([
      "filediff-src/a.go",
      "binary-src/img.png",
      "filediff-zz.go",
    ]);
  });
});
