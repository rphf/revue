import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileVersions } from "../types";
import {
  blockForLine,
  blockTarget,
  diffBlocks,
  isMarkdownPath,
  resolveRepoPath,
  useRichDocs,
} from "./richDiff";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: { getDiffFile: vi.fn(), assetUrl: (p: string) => `/asset/${p}` },
}));

import { api } from "../api";

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
    expect(blocks[4].item).toBe(true);
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

describe("block lines", () => {
  const before = "# Title\n\nKept\nparagraph.\n\nOld paragraph.\n";
  const after =
    "# Title\n\nNew intro.\n\nKept\nparagraph.\n\n\n- one\n- two\n\n```js\na\n\nb\n```\n";

  it("keeps the source lines of each block on the side it has", () => {
    const blocks = diffBlocks(before, after);
    expect(blocks.map((b) => [b.change, b.oldLines, b.newLines])).toEqual([
      ["same", [1, 1], [1, 1]],
      ["added", undefined, [3, 3]],
      ["same", [3, 4], [5, 6]],
      ["removed", [6, 6], undefined],
      ["added", undefined, [9, 9]],
      ["added", undefined, [10, 10]],
      ["added", undefined, [12, 16]],
    ]);
  });

  it("targets the old file for a removed block, the new one otherwise", () => {
    const blocks = diffBlocks(before, after);
    expect(blockTarget(blocks[1])).toEqual({ side: "additions", line: 3 });
    expect(blockTarget(blocks[2])).toEqual({
      side: "additions",
      line: 6,
      startLine: 5,
    });
    expect(blockTarget(blocks[3])).toEqual({ side: "deletions", line: 6 });
  });

  it("finds the block of a line, or the next one from a gap", () => {
    const blocks = diffBlocks(before, after);
    expect(blockForLine(blocks, "additions", 6)).toBe(2);
    expect(blockForLine(blocks, "additions", 7)).toBe(4);
    expect(blockForLine(blocks, "deletions", 4)).toBe(2);
    expect(blockForLine(blocks, "deletions", 6)).toBe(3);
    expect(blockForLine(blocks, "additions", 99)).toBe(-1);
  });

  it("makes each item of a list a block of its own", () => {
    const blocks = diffBlocks(
      "Intro.\n\n3. three\n4. four\n   more\n\n   - nested\n5. five\n",
      "Intro.\n\n3. three\n4. changed\n5. five\n",
    );
    expect(
      blocks.map((b) => [b.change, b.item, b.oldLines, b.newLines]),
    ).toEqual([
      ["same", false, [1, 1], [1, 1]],
      ["same", true, [3, 3], [3, 3]],
      ["removed", true, [4, 7], undefined],
      ["added", true, undefined, [4, 4]],
      ["same", true, [8, 8], [5, 5]],
    ]);
    expect(blocks[2].html).toContain('<ol start="4">');
    expect(blocks[2].html).toContain("nested");
    expect(blocks[4].html).toContain('<ol start="5">');
    expect(blockTarget(blocks[3])).toEqual({ side: "additions", line: 4 });
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

  it("routes the sources of a picture through the resolver", () => {
    const [block] = diffBlocks(
      null,
      '<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="docs/dark.png, docs/dark@2x.png 2x">\n  <img src="docs/light.png" alt="">\n</picture>\n',
      { resolveImage: (src) => `/asset?path=${encodeURIComponent(src)}` },
    );
    expect(block.html).toContain(
      'srcset="/asset?path=docs%2Fdark.png, /asset?path=docs%2Fdark%402x.png 2x"',
    );
    expect(block.html).toContain('src="/asset?path=docs%2Flight.png"');
  });

  it("keeps a srcset URL with a comma inside whole", () => {
    const [block] = diffBlocks(
      null,
      '<img srcset="docs/a,b.png 1x,docs/c.png 2x" alt="">\n',
      { resolveImage: (src) => `/a/${src}` },
    );
    expect(block.html).toContain(
      'srcset="/a/docs/a,b.png 1x, /a/docs/c.png 2x"',
    );
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

describe("useRichDocs", () => {
  const versions = (text: string): FileVersions => ({
    path: "a.md",
    status: "modified",
    isBinary: false,
    oldContent: "# Old\n",
    newContent: text,
  });
  const meta = () => ({ name: "a.md" }) as FileDiffMetadata;
  const paths = new Set(["a.md"]);
  const args: string[] = [];

  it("refetches only a file that moved, keeping its document meanwhile", async () => {
    let answer: (v: FileVersions) => void = () => {};
    vi.mocked(api.getDiffFile)
      .mockResolvedValueOnce(versions("# First\n"))
      .mockReturnValueOnce(new Promise((r) => (answer = r)));
    const first = [meta()];
    const { result, rerender } = renderHook(
      ({ files }) => useRichDocs(args, files, paths),
      { initialProps: { files: first } },
    );
    expect(result.current.get("a.md")?.status).toBe("loading");
    await waitFor(() =>
      expect(result.current.get("a.md")?.status).toBe("ready"),
    );

    // The same parsed file: nothing to fetch.
    rerender({ files: [...first] });
    expect(api.getDiffFile).toHaveBeenCalledTimes(1);

    // The file moved: the old document stays until the new one lands.
    rerender({ files: [meta()] });
    expect(api.getDiffFile).toHaveBeenCalledTimes(2);
    const before = result.current.get("a.md");
    expect(before?.status).toBe("ready");
    await act(async () => answer(versions("# Second\n")));
    const after = result.current.get("a.md");
    expect(after?.rev).not.toBe(before?.rev);
    expect(
      after?.status === "ready" && after.blocks.map((b) => b.html).join(),
    ).toContain("Second");
  });

  it("drops a file that left the diff", async () => {
    vi.mocked(api.getDiffFile).mockResolvedValue(versions("# Doc\n"));
    const { result, rerender } = renderHook(
      ({ files }) => useRichDocs(args, files, paths),
      { initialProps: { files: [meta()] } },
    );
    await waitFor(() =>
      expect(result.current.get("a.md")?.status).toBe("ready"),
    );
    rerender({ files: [] });
    expect(result.current.has("a.md")).toBe(false);
  });
});
