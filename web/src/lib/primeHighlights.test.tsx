import { renderHook, waitFor } from "@testing-library/react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { beforeEach, expect, test, vi } from "vitest";
import { usePrimedHighlights } from "./primeHighlights";

const prime = vi.fn<(file: FileDiffMetadata) => Promise<void>>();
vi.mock("@pierre/diffs/react", () => ({
  useWorkerPool: () => ({ primeDiffHighlightCache: prime }),
}));

const file = (name: string, lines: number) =>
  ({ name, unifiedLineCount: lines }) as FileDiffMetadata;

beforeEach(() => {
  prime.mockReset();
  prime.mockResolvedValue();
});

test("highlights the files in the order given", async () => {
  renderHook(() => usePrimedHighlights([file("b.ts", 10), file("a.ts", 10)]));
  await waitFor(() => expect(prime).toHaveBeenCalledTimes(2));
  expect(prime.mock.calls.map(([f]) => f.name)).toEqual(["b.ts", "a.ts"]);
});

test("stops at the line budget", async () => {
  renderHook(() =>
    usePrimedHighlights([
      file("a.ts", 30_000),
      file("b.ts", 30_000),
      file("c.ts", 10),
    ]),
  );
  await waitFor(() => expect(prime).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(prime.mock.calls.map(([f]) => f.name)).toEqual(["a.ts"]);
});

test("gives up when the pool does not work", async () => {
  prime.mockRejectedValue(new Error("no workers"));
  renderHook(() => usePrimedHighlights([file("a.ts", 10), file("b.ts", 10)]));
  await waitFor(() => expect(prime).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(prime).toHaveBeenCalledTimes(1);
});
