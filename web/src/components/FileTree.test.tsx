import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import FileTree from "./FileTree";
import type { DiffFile } from "../types";

function file(
  path: string,
  status: DiffFile["status"] = "modified",
  extra: Partial<DiffFile> = {},
): DiffFile {
  return { path, status, isBinary: false, ...extra };
}

const noop = () => {};

// The tree renders into an open shadow root; testing-library queries do
// not pierce it, so rows are looked up by the library's data attributes.
function shadow(container: HTMLElement): ShadowRoot {
  const host = container.querySelector("file-tree-container");
  if (!host?.shadowRoot) throw new Error("tree host not rendered");
  return host.shadowRoot;
}

const ROW = '[data-type="item"]:not([data-file-tree-sticky-row])';

function rows(container: HTMLElement): HTMLElement[] {
  return [...shadow(container).querySelectorAll<HTMLElement>(ROW)];
}

// Directory rows carry a trailing slash in their path attribute.
function row(container: HTMLElement, path: string): HTMLElement | null {
  return rows(container).find((el) => el.dataset.itemPath === path) ?? null;
}

function rowPaths(container: HTMLElement): string[] {
  return rows(container).map((el) => el.dataset.itemPath ?? "");
}

function gitLane(container: HTMLElement, path: string): string {
  return (
    row(container, path)?.querySelector('[data-item-section="git"]')
      ?.textContent ?? ""
  );
}

function viewedDot(container: HTMLElement, path: string): HTMLElement {
  const dot = row(container, path)?.querySelector<HTMLElement>(
    '[data-item-section="decoration"] > span',
  );
  if (!dot) throw new Error(`no viewed dot for ${path}`);
  return dot;
}

describe("FileTree", () => {
  it("renders a row per file with status letters, nested under directories", () => {
    const files = [
      file("src/app/main.go", "modified"),
      file("src/app/util.go", "added"),
      file("README.md", "deleted"),
    ];
    const { container } = render(
      <FileTree
        files={files}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );

    // src/ only holds app/, so the chain flattens into one directory row.
    expect(rowPaths(container)).toEqual([
      "src/app/",
      "src/app/main.go",
      "src/app/util.go",
      "README.md",
    ]);
    expect(row(container, "src/app/")).toHaveAttribute(
      "aria-label",
      "src / app",
    );
    expect(row(container, "src/app/main.go")).toHaveAttribute(
      "aria-label",
      "main.go",
    );
    expect(gitLane(container, "src/app/main.go")).toBe("M");
    expect(gitLane(container, "src/app/util.go")).toBe("A");
    expect(gitLane(container, "README.md")).toBe("D");
    expect(row(container, "README.md")).toHaveAttribute(
      "data-item-git-status",
      "deleted",
    );
  });

  it("shows the header counts and the empty state", () => {
    const files = [file("a.txt"), file("b.txt")];
    const { rerender } = render(
      <FileTree
        files={files}
        additions={12}
        deletions={3}
        viewed={new Set(["a.txt"])}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("2 files")).toBeInTheDocument();
    expect(screen.getByText("1 viewed")).toBeInTheDocument();
    expect(
      screen.getByLabelText("12 added, 3 removed lines"),
    ).toHaveTextContent("+12 −3");

    rerender(
      <FileTree
        files={files}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );
    expect(
      screen.queryByLabelText(/added, .* removed lines/),
    ).not.toBeInTheDocument();

    rerender(
      <FileTree
        files={[]}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("No changed files")).toBeInTheDocument();
  });

  it("collapses and expands directories", async () => {
    const { container } = render(
      <FileTree
        files={[file("pkg/deep/thing.go")]}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );
    expect(row(container, "pkg/deep/thing.go")).not.toBeNull();
    fireEvent.click(row(container, "pkg/deep/")!);
    await waitFor(() => expect(row(container, "pkg/deep/thing.go")).toBeNull());
    fireEvent.click(row(container, "pkg/deep/")!);
    await waitFor(() =>
      expect(row(container, "pkg/deep/thing.go")).not.toBeNull(),
    );
  });

  it("reports file activation, including re-clicks on the selected file", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <FileTree
        files={[file("x.go"), file("dir/y.go")]}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={onSelect}
        selectedPath="x.go"
      />,
    );
    fireEvent.click(row(container, "x.go")!);
    fireEvent.click(row(container, "x.go")!);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith("x.go");

    // Directory rows toggle; they never jump the diff.
    fireEvent.click(row(container, "dir/")!);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("mirrors an outside selection into the tree, revealing collapsed dirs", async () => {
    const onSelect = vi.fn();
    const files = [file("a.go"), file("lib/deep/b.go")];
    const { container, rerender } = render(
      <FileTree
        files={files}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(row(container, "lib/deep/")!);
    await waitFor(() => expect(row(container, "lib/deep/b.go")).toBeNull());

    rerender(
      <FileTree
        files={files}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={onSelect}
        selectedPath="lib/deep/b.go"
      />,
    );
    await waitFor(() =>
      expect(row(container, "lib/deep/b.go")).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    // Mirroring never bounces back as a jump.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("toggles viewed through the dot without activating the row", async () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const files = [file("a.txt")];
    const { container, rerender } = render(
      <FileTree
        files={files}
        viewed={new Set()}
        onToggleViewed={onToggle}
        onSelect={onSelect}
      />,
    );
    expect(viewedDot(container, "a.txt")).toHaveAttribute(
      "title",
      "Mark as viewed",
    );
    fireEvent.click(viewedDot(container, "a.txt"));
    expect(onToggle).toHaveBeenCalledWith("a.txt");
    expect(onSelect).not.toHaveBeenCalled();

    rerender(
      <FileTree
        files={files}
        viewed={new Set(["a.txt"])}
        onToggleViewed={onToggle}
        onSelect={onSelect}
      />,
    );
    await waitFor(() =>
      expect(viewedDot(container, "a.txt")).toHaveAttribute(
        "title",
        "Mark as not viewed",
      ),
    );
  });

  it("offers the viewed toggle in the context menu", async () => {
    const onToggle = vi.fn();
    const { container } = render(
      <FileTree
        files={[file("a.txt")]}
        viewed={new Set()}
        onToggleViewed={onToggle}
        onSelect={noop}
      />,
    );
    fireEvent.contextMenu(row(container, "a.txt")!);
    const item = await screen.findByRole("menuitem", {
      name: "Mark as viewed",
    });
    fireEvent.click(item);
    expect(onToggle).toHaveBeenCalledWith("a.txt");
    await waitFor(() =>
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument(),
    );
  });

  it("renders path text inertly even when it looks like HTML", () => {
    const evil = '<img src=x onerror="window.__pwned=1">.go';
    const { container } = render(
      <FileTree
        files={[file(evil)]}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );
    const rendered = row(container, evil);
    expect(rendered).not.toBeNull();
    expect(rendered).toHaveAttribute("aria-label", evil);
    expect(shadow(container).querySelector("img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("treePathCompare", () => {
  it("orders leaves exactly as the tree lays them out", async () => {
    const { treePathCompare } = await import("./treePath");
    const paths = [
      "zz.md",
      "src/b.ts",
      "app/deep/x.ts",
      "src/a.ts",
      "app/a.ts",
      "README.md",
      ".github/ci.yml",
      "Makefile",
      "cmd/Main.go",
      "cmd/aux.go",
    ];
    const sorted = [...paths].sort(treePathCompare);
    // Dirs first (dot-dirs before the rest), depth-first within, then
    // root files; names compare case-insensitively.
    expect(sorted).toEqual([
      ".github/ci.yml",
      "app/deep/x.ts",
      "app/a.ts",
      "cmd/aux.go",
      "cmd/Main.go",
      "src/a.ts",
      "src/b.ts",
      "Makefile",
      "README.md",
      "zz.md",
    ]);
  });

  it("is the order the tree itself renders", async () => {
    const { treePathCompare } = await import("./treePath");
    const paths = [
      "src/file10.ts",
      "src/file2.ts",
      "src/lib/x.ts",
      "b.md",
      ".env",
      "A.md",
    ];
    const { container } = render(
      <FileTree
        files={paths.map((p) => file(p))}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );
    const leaves = rowPaths(container).filter((p) => !p.endsWith("/"));
    expect(leaves).toEqual([...paths].sort(treePathCompare));
  });
});
