import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffFile } from "../types";

vi.mock("@pierre/diffs", () => ({
  processFile: vi.fn(
    () => ({ name: "a.go", isPartial: false }) as FileDiffMetadata,
  ),
}));

vi.mock("../api", () => ({
  api: {
    getDiffFile: vi.fn(async () => ({
      path: "a.go",
      oldPath: "",
      status: "modified",
      isBinary: false,
      oldContent: "old line 1\nold line 2\n",
      newContent: "line1\nEXPANDED CONTEXT\nline3\n",
    })),
  },
}));

import { processFile } from "@pierre/diffs";
import { api } from "../api";
import { splitPatch, useFullDiffs } from "./ContextExpand";

const PATCH = `diff --git a/a.go b/a.go
index 111..222 100644
--- a/a.go
+++ b/a.go
@@ -1,2 +1,2 @@
 line1
-old
+new
diff --git a/b.go b/b.go
index 333..444 100644
--- a/b.go
+++ b/b.go
@@ -1 +1 @@
-x
+y
`;

function Harness({
  parsed,
  diffFiles,
  version,
  target,
}: {
  parsed: FileDiffMetadata[];
  diffFiles: DiffFile[];
  version: number;
  target: string;
}) {
  const { files, requestUpgrade } = useFullDiffs(
    [],
    version,
    parsed,
    diffFiles,
    PATCH,
  );
  return (
    <div>
      <button type="button" onClick={() => requestUpgrade(target)}>
        upgrade
      </button>
      <ul>
        {files?.map((f) => (
          <li key={f.name} data-testid={`file-${f.name}`}>
            {f.name}:{f.isPartial ? "partial" : "full"}
          </li>
        ))}
      </ul>
    </div>
  );
}

describe("splitPatch", () => {
  it("slices a multi-file patch into per-file sections", () => {
    const sections = splitPatch(PATCH);
    expect([...sections.keys()]).toEqual(["a.go", "b.go"]);
    expect(sections.get("a.go")).toContain("+new");
    expect(sections.get("a.go")).not.toContain("+y");
  });

  it("keys deleted files by their old path", () => {
    const patch = `diff --git a/gone.go b/gone.go
--- a/gone.go
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;
    expect([...splitPatch(patch).keys()]).toEqual(["gone.go"]);
  });
});

describe("useFullDiffs (lazy)", () => {
  afterEach(() => vi.clearAllMocks());

  const partial = { name: "a.go", isPartial: true } as FileDiffMetadata;
  const diffFile: DiffFile = {
    path: "a.go",
    status: "modified",
    isBinary: false,
  };

  it("does nothing eagerly: no content fetches on mount", async () => {
    render(
      <Harness
        parsed={[partial]}
        diffFiles={[diffFile]}
        version={3}
        target="a.go"
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getDiffFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-a.go")).toHaveTextContent("a.go:partial");
  });

  it("upgrades one file on request with both versions from the capture", async () => {
    render(
      <Harness
        parsed={[partial]}
        diffFiles={[diffFile]}
        version={3}
        target="a.go"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "upgrade" }));

    // The file flips from partial to full, which changes the DiffView
    // key and forces the remount.
    await waitFor(() =>
      expect(screen.getByTestId("file-a.go")).toHaveTextContent("a.go:full"),
    );

    expect(api.getDiffFile).toHaveBeenCalledTimes(1);
    expect(api.getDiffFile).toHaveBeenCalledWith([], "a.go");
    const call = vi.mocked(processFile).mock.calls[0];
    expect(call[0]).toContain("diff --git a/a.go b/a.go");
    expect(call[1]?.newFile?.contents).toContain("EXPANDED CONTEXT");
    expect(call[1]?.oldFile?.contents).toContain("old line 1");

    // A second request for the same file is a no-op.
    fireEvent.click(screen.getByRole("button", { name: "upgrade" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getDiffFile).toHaveBeenCalledTimes(1);
  });

  it("starts over when the capture version changes", async () => {
    const { rerender } = render(
      <Harness
        parsed={[partial]}
        diffFiles={[diffFile]}
        version={3}
        target="a.go"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "upgrade" }));
    await waitFor(() =>
      expect(screen.getByTestId("file-a.go")).toHaveTextContent("a.go:full"),
    );
    rerender(
      <Harness
        parsed={[partial]}
        diffFiles={[diffFile]}
        version={4}
        target="a.go"
      />,
    );
    expect(screen.getByTestId("file-a.go")).toHaveTextContent("a.go:partial");
  });

  it("ignores requests for binary files and unknown paths", async () => {
    render(
      <Harness
        parsed={[partial]}
        diffFiles={[{ ...diffFile, isBinary: true }]}
        version={3}
        target="a.go"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "upgrade" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getDiffFile).not.toHaveBeenCalled();

    render(
      <Harness
        parsed={[partial]}
        diffFiles={[diffFile]}
        version={3}
        target="not-in-patch.go"
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "upgrade" })[1]);
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getDiffFile).not.toHaveBeenCalled();
  });
});
