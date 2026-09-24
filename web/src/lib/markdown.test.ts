import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

function dom(source: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(source);
  return el;
}

describe("renderMarkdown", () => {
  it("keeps a single newline as a line break", () => {
    const el = dom("line one\nline two");
    expect(el.querySelectorAll("p")).toHaveLength(1);
    expect(el.querySelector("p br")).not.toBeNull();
  });

  it("turns a tagged quote into a GitHub alert", () => {
    const el = dom("> [!WARNING]\n> Mind the gap.");
    const box = el.querySelector(".markdown-alert-warning");
    expect(box).not.toBeNull();
    expect(el.querySelector("blockquote")).toBeNull();
    expect(box?.querySelector(".markdown-alert-title")?.textContent).toBe(
      "Warning",
    );
    expect(box?.textContent).toContain("Mind the gap.");
    expect(box?.textContent).not.toContain("[!WARNING]");
  });

  it("leaves a plain quote a quote", () => {
    const el = dom("> just a quote");
    expect(el.querySelector("blockquote")).not.toBeNull();
    expect(el.querySelector(".markdown-alert")).toBeNull();
  });

  it("keeps task lists and collapsible sections, and drops scripts", () => {
    const el = dom(
      "- [x] done\n\n<details><summary>More</summary>\n\nhidden\n\n</details>\n\n<script>alert(1)</script><img src=x onerror=alert(1)>",
    );
    expect(el.querySelector('input[type="checkbox"][checked]')).not.toBeNull();
    expect(el.querySelector("details summary")?.textContent).toBe("More");
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")?.getAttribute("onerror")).toBeNull();
  });
});
