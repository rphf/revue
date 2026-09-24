import { describe, expect, it } from "vitest";
import {
  code,
  continueList,
  type Edit,
  indentList,
  link,
  pasteLink,
  prefixLines,
  wrap,
} from "./mdEdit";

// apply returns the text after an edit, with [ and ] around the
// selection it leaves, so a test reads as the textarea would look.
function apply(value: string, e: Edit | null): string {
  if (!e) return "unchanged";
  const next = value.slice(0, e.from) + e.text + value.slice(e.to);
  return (
    next.slice(0, e.selStart) +
    "[" +
    next.slice(e.selStart, e.selEnd) +
    "]" +
    next.slice(e.selEnd)
  );
}

describe("wrap", () => {
  it("wraps the selection and toggles back", () => {
    expect(apply("a word b", wrap("a word b", 2, 6, "`"))).toBe("a `[word]` b");
    expect(apply("a `word` b", wrap("a `word` b", 3, 7, "`"))).toBe(
      "a [word] b",
    );
  });
  it("leaves the caret between the marks with nothing selected", () => {
    expect(apply("ab", wrap("ab", 1, 1, "**"))).toBe("a**[]**b");
  });
});

describe("code", () => {
  it("fences a selection across lines", () => {
    expect(apply("x\ny", code("x\ny", 0, 3))).toBe("```\n[x\ny]\n```");
  });
});

describe("link", () => {
  it("selects the URL to type", () => {
    expect(apply("see docs", link("see docs", 4, 8))).toBe("see [docs]([url])");
  });
  it("puts the caret in the text with nothing selected", () => {
    expect(apply("", link("", 0, 0))).toBe("[[]](url)");
  });
});

describe("prefixLines", () => {
  it("numbers every selected line and takes the numbers off again", () => {
    const v = "one\ntwo";
    expect(apply(v, prefixLines(v, 0, 7, "number"))).toBe("[1. one\n2. two]");
    const n = "1. one\n2. two";
    expect(apply(n, prefixLines(n, 0, n.length, "number"))).toBe("[one\ntwo]");
  });
  it("quotes the caret's line and keeps the caret in its text", () => {
    expect(apply("hello", prefixLines("hello", 2, 2, "quote"))).toBe(
      "> he[]llo",
    );
  });
  it("tells a task from a plain bullet", () => {
    const v = "- [ ] a";
    expect(apply(v, prefixLines(v, 0, v.length, "bullet"))).toBe("[- - [ ] a]");
    expect(apply(v, prefixLines(v, 0, v.length, "task"))).toBe("[a]");
  });
});

describe("continueList", () => {
  it("starts the next item of each kind", () => {
    expect(apply("- a", continueList("- a", 3, 3))).toBe("- a\n- []");
    expect(apply("  3. c", continueList("  3. c", 6, 6))).toBe(
      "  3. c\n  4. []",
    );
    expect(apply("- [x] done", continueList("- [x] done", 10, 10))).toBe(
      "- [x] done\n- [ ] []",
    );
  });
  it("ends the list on an empty item", () => {
    expect(apply("- a\n- ", continueList("- a\n- ", 6, 6))).toBe("- a\n[]");
  });
  it("leaves plain lines and selections alone", () => {
    expect(apply("text", continueList("text", 4, 4))).toBe("unchanged");
    expect(apply("- a", continueList("- a", 0, 3))).toBe("unchanged");
  });
});

describe("indentList", () => {
  it("indents and outdents list items", () => {
    expect(apply("- a", indentList("- a", 3, 3, false))).toBe("  - a[]");
    expect(apply("  - a", indentList("  - a", 5, 5, true))).toBe("- a[]");
  });
  it("leaves Tab alone outside a list", () => {
    expect(apply("text", indentList("text", 0, 0, false))).toBe("unchanged");
  });
});

describe("pasteLink", () => {
  it("links the selected text to a pasted URL", () => {
    expect(
      apply("see docs", pasteLink("see docs", 4, 8, "https://x.dev/a")),
    ).toBe("see [docs](https://x.dev/a)[]");
  });
  it("leaves other pastes alone", () => {
    expect(apply("see", pasteLink("see", 3, 3, "https://x.dev"))).toBe(
      "unchanged",
    );
    expect(apply("see docs", pasteLink("see docs", 4, 8, "not a url"))).toBe(
      "unchanged",
    );
  });
});
