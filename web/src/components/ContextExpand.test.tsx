import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { RoundFile } from "../types";

vi.mock("@pierre/diffs", () => ({
  processFile: vi.fn(
    () => ({ name: "a.go", isPartial: false }) as FileDiffMetadata,
  ),
}));

vi.mock("../api", () => ({
  api: {
    getFileVersions: vi.fn(async () => ({
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
  roundFiles,
  seq,
  target,
}: {
  parsed: FileDiffMetadata[];
  roundFiles: RoundFile[];
  seq: number;
  target: string;
}) {
  const { files, requestUpgrade } = useFullDiffs(
    1,
    seq,
    parsed,
    roundFiles,
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

describe("useFullDiffs (R25, lazy)", () => {
  afterEach(() => vi.clearAllMocks());

  const partial = { name: "a.go", isPartial: true } as FileDiffMetadata;
  const roundFile: RoundFile = {
    id: 1,
    roundId: 3,
    path: "a.go",
    status: "modified",
    isBinary: false,
  };

  it("does nothing eagerly: no snapshot fetches on mount", async () => {
    render(
      <Harness
        parsed={[partial]}
        roundFiles={[roundFile]}
        seq={3}
        target="a.go"
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getFileVersions).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-a.go")).toHaveTextContent("a.go:partial");
  });

  it("upgrades one file on request with snapshot contents from the round", async () => {
    render(
      <Harness
        parsed={[partial]}
        roundFiles={[roundFile]}
        seq={3}
        target="a.go"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "upgrade" }));

    // The file flips from partial to full, which changes the DiffView
    // key and forces the remount.
    await waitFor(() =>
      expect(screen.getByTestId("file-a.go")).toHaveTextContent("a.go:full"),
    );

    // Contents came from the round's frozen snapshot endpoint — the
    // live tree is never read (AE-adjacent to R8).
    expect(api.getFileVersions).toHaveBeenCalledTimes(1);
    expect(api.getFileVersions).toHaveBeenCalledWith(1, 3, "a.go");
    const call = vi.mocked(processFile).mock.calls[0];
    expect(call[0]).toContain("diff --git a/a.go b/a.go");
    expect(call[1]?.newFile?.contents).toContain("EXPANDED CONTEXT");
    expect(call[1]?.oldFile?.contents).toContain("old line 1");

    // A second request for the same file is a no-op.
    fireEvent.click(screen.getByRole("button", { name: "upgrade" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getFileVersions).toHaveBeenCalledTimes(1);
  });

  it("ignores requests for binary files and unknown paths", async () => {
    render(
      <Harness
        parsed={[partial]}
        roundFiles={[{ ...roundFile, isBinary: true }]}
        seq={3}
        target="a.go"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "upgrade" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getFileVersions).not.toHaveBeenCalled();

    render(
      <Harness
        parsed={[partial]}
        roundFiles={[roundFile]}
        seq={3}
        target="not-in-patch.go"
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "upgrade" })[1]);
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getFileVersions).not.toHaveBeenCalled();
  });
});
