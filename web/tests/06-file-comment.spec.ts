import { expect, test } from "@playwright/test";
import { api, authenticate, writeFixtureFile } from "./helpers/seed";

// A comment on the whole file starts from the file header and sits
// under it, above the first hunk.
test("a file comment starts from the header and sits above the hunks", async ({
  page,
}) => {
  writeFixtureFile(
    "beta.go",
    `package main

func beta() {
	println("beta one")
	println("beta two file comment")
	println("beta three")
}
`,
  );
  await authenticate(page, "/");
  const firstLine = page.getByText("beta two file comment").first();
  await expect(firstLine).toBeVisible({ timeout: 10_000 });

  await page
    .getByRole("button", { name: "Comment on beta.go" })
    .dispatchEvent("click");
  await page.getByPlaceholder("Comment on this file").fill("whole file note");
  await page
    .getByRole("button", { name: "Start thread" })
    .dispatchEvent("click");

  const note = page.getByText("whole file note");
  await expect(note).toBeVisible();
  const noteBox = await note.boundingBox();
  const lineBox = await firstLine.boundingBox();
  expect(noteBox!.y).toBeLessThan(lineBox!.y);

  // Once sent, the agent sees it on line 0, with no quoted code.
  await api("POST", "/api/send", { note: "" });
  const { threads } = await api<{
    threads: { path: string; line: number; quote?: unknown }[];
  }>("GET", "/api/feedback?since=0");
  const fileThread = threads.find((t) => t.path === "beta.go" && t.line === 0);
  expect(fileThread).toBeDefined();
  expect(fileThread?.quote).toBeUndefined();
});
