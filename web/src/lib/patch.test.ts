import { describe, expect, it } from "vitest";
import { loadedFiles, splitPatch } from "./patch";

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

describe("loadedFiles", () => {
  it("names the old side by its old path for a rename", () => {
    expect(
      loadedFiles({
        path: "new.go",
        oldPath: "old.go",
        status: "renamed",
        isBinary: false,
        oldContent: "a\n",
        newContent: "b\n",
      }),
    ).toEqual({
      oldFile: { name: "old.go", contents: "a\n" },
      newFile: { name: "new.go", contents: "b\n" },
    });
  });

  it("uses the path for both sides of a change", () => {
    expect(
      loadedFiles({
        path: "a.go",
        status: "modified",
        isBinary: false,
        oldContent: "a\n",
        newContent: "b\n",
      }).oldFile?.name,
    ).toBe("a.go");
  });

  it("refuses a file without a new version", () => {
    expect(() =>
      loadedFiles({
        path: "gone.go",
        status: "deleted",
        isBinary: false,
        oldContent: "a\n",
        newContent: null,
      }),
    ).toThrow(/no new version/);
  });
});
