import { expect, test } from "@playwright/test";
import { authenticate } from "./helpers/seed";

// The seeded review renders tree and diff (R2).
test("seeded review renders the file tree and the diff", async ({ page }) => {
  await authenticate(page, "/reviews/1");

  // Token-free URL after the exchange (R23).
  expect(page.url()).not.toContain("token=");

  // Tree: both changed files with modified badges.
  await expect(page.getByRole("button", { name: "alpha.go", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "beta.go", exact: true })).toBeVisible();

  // Diff: rendered patch content, additions and deletions.
  await expect(page.getByText("alpha three v2").first()).toBeVisible();
  await expect(page.getByText("alpha three v1").first()).toBeVisible();
  await expect(page.getByText("beta two v2").first()).toBeVisible();

  // Review chrome.
  await expect(page.getByText("#1", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("open", { exact: true })).toBeVisible();
});
