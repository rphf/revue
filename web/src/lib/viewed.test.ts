import { describe, expect, it } from "vitest";
import { fingerprints } from "./viewed";

describe("fingerprints", () => {
  it("names each file by its blob ids", () => {
    const patch =
      "diff --git a/a.go b/a.go\nindex 111..222 100644\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-x\n+y\n" +
      "diff --git a/old.go b/old.go\ndeleted file mode 100644\nindex 333..000\n--- a/old.go\n+++ /dev/null\n";
    expect(fingerprints(patch)).toEqual(
      new Map([
        ["a.go", "111..222 100644"],
        ["old.go", "333..000"],
      ]),
    );
  });

  it("keeps the fingerprint when only the hunks differ, as with whitespace hidden", () => {
    const a = fingerprints(
      "diff --git a/a.go b/a.go\nindex 1..2 100644\n--- a/a.go\n+++ b/a.go\n+x\n+ y\n",
    );
    const b = fingerprints(
      "diff --git a/a.go b/a.go\nindex 1..2 100644\n--- a/a.go\n+++ b/a.go\n+x\n",
    );
    expect(a.get("a.go")).toBe(b.get("a.go"));
  });

  it("names a binary file from its header, and a section with no index by its text", () => {
    const binary =
      "diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files differ\n";
    const rename =
      "diff --git a/x.go b/y.go\nsimilarity index 100%\nrename from x.go\nrename to y.go\n";
    const prints = fingerprints(binary + rename, ["img.png", "y.go"]);
    expect(prints.get("img.png")).toBe("1..2 100644");
    expect(prints.get("y.go")).toBe(rename);
  });
});
