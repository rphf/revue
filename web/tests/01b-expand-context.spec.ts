import { expect, test } from "@playwright/test";
import { authenticate } from "./helpers/seed";

// Hunk context expands in place: the page fetches a file's two versions
// only when the reviewer first expands a separator in it.
test("expanding a separator loads that file's context on demand", async ({
  page,
}) => {
  const fileRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/diff/file")) fileRequests.push(r.url());
  });

  await authenticate(page, "/");
  await expect(page.getByText("alpha three v2").first()).toBeVisible();
  await expect(page.getByText("package main")).toHaveCount(0);
  expect(fileRequests).toEqual([]);

  await page.locator("[data-expand-button]").first().click();

  await expect(page.getByText("package main").first()).toBeVisible();
  expect(fileRequests).toHaveLength(1);
  expect(fileRequests[0]).toContain("path=alpha.go");
});
