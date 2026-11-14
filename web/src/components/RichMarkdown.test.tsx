import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { diffBlocks, type RichDoc } from "@/lib/richDiff";
import RichMarkdown from "./RichMarkdown";
import { RichNotesContext } from "./richNotes";

const doc: RichDoc = {
  rev: "r",
  status: "ready",
  blocks: diffBlocks("# Title\n\nOld.\n", "# Title\n\nNew\nlines.\n\nLast.\n"),
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("--rich-width");
});

describe("RichMarkdown comments", () => {
  it("starts a comment on the source lines of a block", () => {
    const onComment = vi.fn();
    render(<RichMarkdown doc={doc} path="README.md" onComment={onComment} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Comment on lines 3–4" }),
    );
    expect(onComment).toHaveBeenCalledWith({
      side: "additions",
      line: 4,
      startLine: 3,
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 3" }));
    expect(onComment).toHaveBeenLastCalledWith({ side: "deletions", line: 3 });
  });

  it("draws each note under the block that holds its line", () => {
    const note = (
      side: "additions" | "deletions",
      line: number,
      id: number,
    ) => ({
      side,
      lineNumber: line,
      metadata: { kind: "thread" as const, threadId: id },
    });
    render(
      <RichNotesContext.Provider
        value={
          new Map([
            ["README.md", [note("additions", 4, 1), note("deletions", 3, 2)]],
          ])
        }
      >
        <RichMarkdown
          doc={doc}
          path="README.md"
          renderNote={(n) => <span>thread {n.metadata?.threadId}</span>}
        />
      </RichNotesContext.Provider>,
    );
    const rowOf = (text: string) => screen.getByText(text).closest(".rich-row");
    expect(rowOf("thread 1")).toHaveTextContent("New lines.");
    expect(rowOf("thread 2")).toHaveTextContent("Old.");
  });

  it("draws the notes of a document with no block", () => {
    render(
      <RichNotesContext.Provider
        value={
          new Map([
            [
              "README.md",
              [
                {
                  side: "additions" as const,
                  lineNumber: 2,
                  metadata: { kind: "thread" as const, threadId: 3 },
                },
              ],
            ],
          ])
        }
      >
        <RichMarkdown
          doc={{ rev: "e", status: "ready", blocks: [] }}
          path="README.md"
          renderNote={(n) => <span>thread {n.metadata?.threadId}</span>}
        />
      </RichNotesContext.Provider>,
    );
    expect(screen.getByText("thread 3")).toBeInTheDocument();
  });
});

describe("RichMarkdown table rows", () => {
  const table: RichDoc = {
    rev: "t",
    status: "ready",
    blocks: diffBlocks(
      null,
      "Intro.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nEnd.\n",
    ),
  };

  it("starts a comment on the row under the pointer", () => {
    const onComment = vi.fn();
    render(<RichMarkdown doc={table} path="README.md" onComment={onComment} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Comment on lines 3–6" }),
    );
    expect(onComment).toHaveBeenLastCalledWith({
      side: "additions",
      line: 6,
      startLine: 3,
    });
    fireEvent.mouseOver(screen.getByText("1"));
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 5" }));
    expect(onComment).toHaveBeenLastCalledWith({ side: "additions", line: 5 });
    fireEvent.mouseOver(screen.getByText("A"));
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 3" }));
    expect(onComment).toHaveBeenLastCalledWith({ side: "additions", line: 3 });
  });

  it("draws a note under the row of its line", () => {
    const note = (line: number, id: number) => ({
      side: "additions" as const,
      lineNumber: line,
      metadata: { kind: "thread" as const, threadId: id },
    });
    render(
      <RichNotesContext.Provider
        value={new Map([["README.md", [note(5, 1), note(4, 2), note(6, 3)]]])}
      >
        <RichMarkdown
          doc={table}
          path="README.md"
          renderNote={(n) => <span>thread {n.metadata?.threadId}</span>}
        />
      </RichNotesContext.Provider>,
    );
    const rowBefore = (text: string) =>
      screen.getByText(text).closest("tr")?.previousElementSibling;
    expect(rowBefore("thread 1")).toHaveTextContent("1 2");
    // A note on the delimiter line belongs to the header.
    expect(rowBefore("thread 2")).toHaveTextContent("A B");
    expect(rowBefore("thread 3")).toHaveTextContent("3 4");
    expect(screen.getByText("thread 1").closest("td")).toHaveAttribute(
      "colspan",
      "2",
    );
  });
});

describe("RichMarkdown width", () => {
  const width = () =>
    document.documentElement.style.getPropertyValue("--rich-width");

  it("restores the saved width", () => {
    localStorage.setItem("revue-rich-width", "900");
    render(<RichMarkdown doc={doc} path="README.md" />);
    expect(width()).toBe("900px");
  });

  it("resizes from the keyboard and resets on a double click", () => {
    render(<RichMarkdown doc={doc} path="README.md" />);
    const handle = screen.getByRole("separator", { name: "Document width" });
    vi.spyOn(handle.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 600,
    } as DOMRect);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(width()).toBe("640px");
    expect(localStorage.getItem("revue-rich-width")).toBe("640");
    fireEvent.doubleClick(handle);
    expect(width()).toBe("");
    expect(localStorage.getItem("revue-rich-width")).toBeNull();
  });
});
