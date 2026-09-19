import { describe, expect, it } from "vitest";
import { diffBlocks, isMarkdownPath, resolveRepoPath } from "./richDiff";

describe("diffBlocks", () => {
  it("marks unchanged, added and removed blocks", () => {
    const before = "# Title\n\nKept paragraph.\n\nOld paragraph.\n";
    const after = "# Title\n\nKept paragraph.\n\nNew paragraph.\n\n- item\n";
    const blocks = diffBlocks(before, after);
    expect(blocks.map((b) => b.change)).toEqual([
      "same",
      "same",
      "removed",
      "added",
      "added",
    ]);
    expect(blocks[0].html).toContain("<h1");
    expect(blocks[2].html).toContain("Old paragraph.");
    expect(blocks[3].html).toContain("New paragraph.");
    expect(blocks[4].html).toContain("<li>item</li>");
  });

  it("treats a missing side as all added or all removed", () => {
    expect(diffBlocks(null, "One.\n\nTwo.").map((b) => b.change)).toEqual([
      "added",
      "added",
    ]);
    expect(diffBlocks("One.", null).map((b) => b.change)).toEqual(["removed"]);
  });

  it("keeps reference links resolvable and strips scripts", () => {
    const md =
      "See [docs][d].\n\n<script>window.x = 1</script>\n\n[d]: https://example.com\n";
    const blocks = diffBlocks(md, md);
    expect(blocks[0].html).toContain('href="https://example.com"');
    expect(blocks.map((b) => b.html).join("")).not.toContain("<script");
  });
});

describe("resolveRepoPath", () => {
  it("resolves relative references against the file's directory", () => {
    expect(resolveRepoPath("README.md", "docs/logo.svg")).toBe("docs/logo.svg");
    expect(resolveRepoPath("docs/install.md", "./img/a.png")).toBe(
      "docs/img/a.png",
    );
    expect(resolveRepoPath("docs/install.md", "../logo.svg")).toBe("logo.svg");
    expect(resolveRepoPath("docs/a.md", "/assets/x.png?v=1")).toBe(
      "assets/x.png",
    );
    expect(resolveRepoPath("docs/a.md", "my%20image.png")).toBe(
      "docs/my image.png",
    );
  });

  it("leaves external, anchor and data references alone", () => {
    expect(resolveRepoPath("a.md", "https://example.com/x.png")).toBeNull();
    expect(resolveRepoPath("a.md", "//cdn.example.com/x.png")).toBeNull();
    expect(resolveRepoPath("a.md", "#section")).toBeNull();
    expect(resolveRepoPath("a.md", "data:image/png;base64,AAAA")).toBeNull();
    expect(resolveRepoPath("a.md", "")).toBeNull();
  });
});

describe("diffBlocks images", () => {
  it("routes image sources through the resolver", () => {
    const blocks = diffBlocks(
      null,
      '![logo](docs/logo.svg)\n\n<img src="docs/mark.png" alt="">\n',
      { resolveImage: (src) => `/asset?path=${encodeURIComponent(src)}` },
    );
    expect(blocks[0].html).toContain('src="/asset?path=docs%2Flogo.svg"');
    expect(blocks[1].html).toContain('src="/asset?path=docs%2Fmark.png"');
  });
});

describe("isMarkdownPath", () => {
  it("matches md and markdown extensions only", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/a.markdown")).toBe(true);
    expect(isMarkdownPath("notes.MD")).toBe(true);
    expect(isMarkdownPath("main.go")).toBe(false);
    expect(isMarkdownPath("mdfile.txt")).toBe(false);
  });
});
