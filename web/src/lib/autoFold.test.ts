import { describe, expect, it } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import { autoFolds, LARGE_DIFF_LINES } from "./autoFold";
import type { DiffFile } from "../types";

function parsed(name: string, added: number, deleted = 0): FileDiffMetadata {
  return {
    name,
    hunks: [{ additionLines: added, deletionLines: deleted }],
  } as FileDiffMetadata;
}

function listed(path: string, extra: Partial<DiffFile> = {}): DiffFile {
  return { path, status: "modified", isBinary: false, ...extra };
}

describe("autoFolds", () => {
  it("folds marked files, then files over the line limit", () => {
    const half = LARGE_DIFF_LINES / 2;
    const folds = autoFolds(
      [
        parsed("a.go", 3),
        parsed("big.go", half, half + 1),
        parsed("edge.go", half, half),
        parsed("gen.ts", LARGE_DIFF_LINES + 1),
        parsed("vendor/x.js", 1),
      ],
      [
        listed("a.go"),
        listed("big.go"),
        listed("edge.go"),
        listed("gen.ts", { fold: "generated" }),
        listed("vendor/x.js", { fold: "vendored" }),
        listed("logo.png", { fold: "vendored", isBinary: true }),
      ],
    );
    expect(Object.fromEntries(folds)).toEqual({
      "big.go": "large",
      "gen.ts": "generated",
      "vendor/x.js": "vendored",
    });
  });
});
