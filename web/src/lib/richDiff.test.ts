import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileVersions } from "../types";
import {
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
