import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import FileTree from "./FileTree";
import type { RoundFile } from "../types";

let nextId = 1;
function file(
  path: string,
  status: RoundFile["status"] = "modified",
  extra: Partial<RoundFile> = {},
): RoundFile {
  return { id: nextId++, roundId: 1, path, status, isBinary: false, ...extra };
}

const noop = () => {};

describe("FileTree", () => {
  it("renders a row per file with status badges, nested under directories", () => {
    const files = [
      file("src/app/main.go", "modified"),
      file("src/app/util.go", "added"),
      file("README.md", "deleted"),
    ];
    render(
      <FileTree
        files={files}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );

    expect(screen.getByText("main.go")).toBeInTheDocument();
    expect(screen.getByText("util.go")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    // Directory nodes render once each.
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("app")).toBeInTheDocument();
    // Badges: M, A, D.
    expect(screen.getByTitle("modified")).toHaveTextContent("M");
    expect(screen.getByTitle("added")).toHaveTextContent("A");
    expect(screen.getByTitle("deleted")).toHaveTextContent("D");
  });

  it("shows old → new path for renames", () => {
    const files = [file("new/name.go", "renamed", { oldPath: "old/name.go" })];
    render(
      <FileTree
        files={files}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );
    const row = screen.getByRole("button", { name: /old\/name\.go/ });
    expect(row).toHaveTextContent("old/name.go → name.go");
    expect(screen.getByTitle("renamed")).toHaveTextContent("R");
  });

  it("toggles viewed state through the dot", () => {
    const onToggle = vi.fn();
    const files = [file("a.txt")];
    const { rerender } = render(
      <FileTree
        files={files}
        viewed={new Set()}
        onToggleViewed={onToggle}
        onSelect={noop}
      />,
    );
    const dot = screen.getByRole("button", { name: "Toggle viewed: a.txt" });
    expect(dot).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(dot);
    expect(onToggle).toHaveBeenCalledWith("a.txt");

    rerender(
      <FileTree
        files={files}
        viewed={new Set(["a.txt"])}
        onToggleViewed={onToggle}
        onSelect={noop}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Toggle viewed: a.txt" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("collapses and expands directories", () => {
    const files = [file("pkg/deep/thing.go")];
    render(
      <FileTree
        files={files}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("thing.go")).toBeInTheDocument();
    fireEvent.click(screen.getByText("pkg"));
    expect(screen.queryByText("thing.go")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("pkg"));
    expect(screen.getByText("thing.go")).toBeInTheDocument();
  });

  it("reports selection clicks", () => {
    const onSelect = vi.fn();
    render(
      <FileTree
        files={[file("x.go")]}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText("x.go"));
    expect(onSelect).toHaveBeenCalledWith("x.go");
  });

  it("renders path text inertly even when it looks like HTML", () => {
    const evil = '<img src=x onerror="window.__pwned=1">.go';
    render(
      <FileTree
        files={[file(evil)]}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows the empty message when there are no files", () => {
    render(
      <FileTree
        files={[]}
        viewed={new Set()}
        onToggleViewed={noop}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("No changed files")).toBeInTheDocument();
  });
});

describe("treePathCompare", () => {
  it("orders leaves exactly as the rendered tree flattens them", async () => {
    const { treePathCompare } = await import("./treePath");
    const paths = [
      "zz.md",
      "src/b.ts",
      "app/deep/x.ts",
      "src/a.ts",
      "app/a.ts",
      "README.md",
    ];
    const sorted = [...paths].sort(treePathCompare);
    // Dirs first (app, src), depth-first within, then root files.
    expect(sorted).toEqual([
      "app/deep/x.ts",
      "app/a.ts",
      "src/a.ts",
      "src/b.ts",
      "README.md",
      "zz.md",
    ]);
  });
});
