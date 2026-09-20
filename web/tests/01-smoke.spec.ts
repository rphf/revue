import { expect, test } from "@playwright/test";
import { authenticate } from "./helpers/seed";

// The page renders the working tree's diff: tree and diff, plus the
// branch and the diff's name in the top bar.
test("the page renders the file tree and the diff of the working tree", async ({
  page,
}) => {
  await authenticate(page, "/");

  // Token-free URL after the exchange.
  expect(page.url()).not.toContain("token=");

  // Tree: both changed files with modified badges.
  await expect(
    page.getByRole("treeitem", { name: "alpha.go", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: "beta.go", exact: true }),
  ).toBeVisible();

  // Diff: rendered patch content, additions and deletions.
  await expect(page.getByText("alpha three v2").first()).toBeVisible();
  await expect(page.getByText("alpha three v1").first()).toBeVisible();
  await expect(page.getByText("beta two v2").first()).toBeVisible();

  // Top bar: the branch, the diff's name, the live dot.
  const picker = page.getByRole("button", { name: "Change diff" });
  await expect(picker).toContainText("main");
  await expect(picker).toContainText("uncommitted");
  await expect(page.getByTestId("live-dot")).toBeVisible();
});
