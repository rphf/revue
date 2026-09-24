import { expect, test } from "@playwright/test";
import { authenticate, git, writeFixtureFile } from "./helpers/seed";

// W leaves whitespace changes out of the diff, as GitHub's "Hide
// whitespace" does: a file with only reindented lines leaves the diff
// and the tree, and comes back on a second W.
test("W hides a file whose only changes are whitespace", async ({ page }) => {
  writeFixtureFile("spaces.go", "package main\n\nfunc spaces() {\n}\n");
  expect((await git(["add", "spaces.go"])).code).toBe(0);
  expect((await git(["commit", "-q", "-m", "add spaces"])).code).toBe(0);
  writeFixtureFile("spaces.go", "package main\n\nfunc spaces() {\n    }\n");

  await authenticate(page, "/");
  const row = page.getByRole("treeitem", { name: "spaces.go" });
  await expect(row).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("w");
  await expect(
    page.getByRole("button", { name: "Show whitespace changes" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("treeitem").first()).toBeVisible();

  await page.keyboard.press("w");
  await expect(row).toBeVisible();
});
