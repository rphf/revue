import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffFile } from "../types";

// The real @pierre/diffs renderer needs Shadow DOM + workers; mock the
// react entry so tests exercise revue's wiring, not the library. The
// stub CodeView walks items in order and invokes the render callbacks
// the way the real one does.
interface StubItem {
  id: string;
  type: "diff" | "file";
  version?: number;
  collapsed?: boolean;
  annotations?: unknown[];
}
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({
    items,
    renderAnnotation,
    renderHeaderPrefix,
    renderHeaderMetadata,
    className,
  }: {
    items: StubItem[];
    renderAnnotation?: (a: unknown, item: StubItem) => React.ReactNode;
    renderHeaderPrefix?: (item: StubItem) => React.ReactNode;
    renderHeaderMetadata?: (item: StubItem) => React.ReactNode;
    className?: string;
  }) => (
    <div className={className}>
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`${item.type === "diff" ? "filediff" : "fileitem"}-${item.id}`}
          data-collapsed={item.collapsed ? "true" : undefined}
          data-version={item.version}
        >
          {renderHeaderPrefix?.(item)}
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

function diffFile(path: string, extra: Partial<DiffFile> = {}): DiffFile {
  return {
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
        diffFiles={[diffFile("a.go"), diffFile("b.go")]}
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
        diffFiles={[
          diffFile("img.png", { isBinary: true, status: "added" }),
          diffFile("code.go"),
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

  it("previews image files from each side they have, with their sizes", () => {
    const imageUrl = (path: string, side: string) => `/img/${side}/${path}`;
    render(
      <DiffView
        files={[]}
        diffFiles={[
          diffFile("new.png", {
            isBinary: true,
            status: "added",
            newSize: 2048,
          }),
          diffFile("pic.png", {
            isBinary: true,
            oldSize: 1024,
            newSize: 1536,
          }),
          diffFile("data.bin", {
            isBinary: true,
            status: "deleted",
            oldSize: 10,
          }),
        ]}
        diffStyle="split"
        theme="light"
        imageUrl={imageUrl}
      />,
    );
    const added = screen.getByTestId("image-diff-new.png");
    expect(within(added).getByRole("img")).toHaveAttribute(
      "src",
      "/img/new/new.png",
    );
    expect(screen.getByTestId("binary-new.png")).toHaveTextContent("2.0 KB");

    const changed = screen.getByTestId("image-diff-pic.png");
    expect(
      within(changed)
        .getAllByRole("img")
        .map((img) => img.getAttribute("src")),
    ).toEqual(["/img/old/pic.png", "/img/new/pic.png"]);
    expect(changed).toHaveClass("grid-cols-2");
    expect(screen.getByTestId("binary-pic.png")).toHaveTextContent(
      "1.0 KB → 1.5 KB (+512 B)",
    );

    expect(screen.queryByTestId("image-diff-data.bin")).not.toBeInTheDocument();
    expect(screen.getByTestId("binary-data.bin")).toHaveTextContent("10 B");
  });

  it("renders the empty state for an empty diff", () => {
    render(
      <DiffView files={[]} diffFiles={[]} diffStyle="unified" theme="light" />,
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
        diffFiles={[diffFile("README.md"), diffFile("main.go")]}
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
        diffFiles={[diffFile("README.md")]}
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
        diffFiles={[
          diffFile("zz.go"),
          diffFile("src/a.go"),
          diffFile("src/img.png", { isBinary: true, status: "added" }),
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

describe("DiffView viewed files", () => {
  it("puts a Viewed checkbox in every file header, binary files included", () => {
    const onToggleViewed = vi.fn();
    render(
      <DiffView
        files={[meta("a.go")]}
        diffFiles={[
          diffFile("a.go"),
          diffFile("img.png", { isBinary: true, status: "added" }),
        ]}
        diffStyle="unified"
        theme="light"
        viewed={new Set(["a.go"])}
        onToggleViewed={onToggleViewed}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Viewed a.go" })).toBeChecked();
    const binary = screen.getByRole("checkbox", { name: "Viewed img.png" });
    expect(binary).not.toBeChecked();
    fireEvent.click(binary);
    expect(onToggleViewed).toHaveBeenCalledWith("img.png");
  });

  it("collapses the files it is told to, with a new item version each time", () => {
    const props = {
      files: [meta("a.go"), meta("b.go")],
      diffFiles: [diffFile("a.go"), diffFile("b.go")],
      diffStyle: "unified" as const,
      theme: "light" as const,
    };
    const { rerender } = render(<DiffView {...props} />);
    const a = () => screen.getByTestId("filediff-a.go");
    const b = () => screen.getByTestId("filediff-b.go");
    expect(a()).toHaveAttribute("data-version", "0");

    rerender(<DiffView {...props} collapsed={new Set(["a.go"])} />);
    expect(a()).toHaveAttribute("data-collapsed", "true");
    expect(a()).toHaveAttribute("data-version", "1");
    expect(b()).not.toHaveAttribute("data-collapsed");
    expect(b()).toHaveAttribute("data-version", "0");

    rerender(<DiffView {...props} collapsed={new Set()} />);
    expect(a()).not.toHaveAttribute("data-collapsed");
    expect(a()).toHaveAttribute("data-version", "2");
  });

  it("puts an arrow before the file name that reports its collapsed state", () => {
    const onToggleCollapsed = vi.fn();
    render(
      <DiffView
        files={[meta("a.go"), meta("b.go")]}
        diffFiles={[diffFile("a.go"), diffFile("b.go")]}
        diffStyle="unified"
        theme="light"
        collapsed={new Set(["a.go"])}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );
    const expand = screen.getByRole("button", { name: "Expand a.go" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Collapse b.go" }),
    ).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(expand);
    expect(onToggleCollapsed).toHaveBeenCalledWith("a.go");
  });
});
