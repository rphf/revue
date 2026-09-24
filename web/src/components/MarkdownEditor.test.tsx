import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MarkdownEditor from "./MarkdownEditor";

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownEditor aria-label="Body" value={value} onValueChange={setValue} />
  );
}

function box(): HTMLTextAreaElement {
  return screen.getByLabelText("Body");
}

describe("MarkdownEditor", () => {
  it("formats the selection from the toolbar", () => {
    render(<Harness initial="make it loud" />);
    box().setSelectionRange(8, 12);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(box()).toHaveValue("make it **loud**");
    expect(box().value.slice(box().selectionStart, box().selectionEnd)).toBe(
      "loud",
    );
  });

  it("formats with GitHub's keys inside the box", () => {
    render(<Harness initial="run make" />);
    box().setSelectionRange(4, 8);
    fireEvent.keyDown(box(), { key: "e", code: "KeyE", ctrlKey: true });
    expect(box()).toHaveValue("run `make`");
  });

  it("continues a list on Enter and ends it on an empty item", () => {
    render(<Harness initial="- one" />);
    box().setSelectionRange(5, 5);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box()).toHaveValue("- one\n- ");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box()).toHaveValue("- one\n");
  });

  it("links selected text to a pasted URL", () => {
    render(<Harness initial="see docs" />);
    box().setSelectionRange(4, 8);
    fireEvent.paste(box(), {
      clipboardData: { getData: () => "https://example.com/docs" },
    });
    expect(box()).toHaveValue("see [docs](https://example.com/docs)");
  });

  it("previews the rendered comment and goes back to writing", async () => {
    render(<Harness initial={"**bold**\n> [!TIP]\n> try it"} />);
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    const preview = screen.getByLabelText("Preview");
    expect(preview.querySelector("strong")?.textContent).toBe("bold");
    expect(preview.querySelector(".markdown-alert-tip")).not.toBeNull();
    expect(box()).not.toBeVisible();

    fireEvent.keyDown(preview, {
      key: "p",
      code: "KeyP",
      ctrlKey: true,
      shiftKey: true,
    });
    await waitFor(() => expect(box()).toBeVisible());
    expect(screen.getByRole("tab", { name: "Write" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
