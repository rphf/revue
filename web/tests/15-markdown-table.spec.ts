import { expect, test } from "@playwright/test";
import { authenticate, writeFixtureFile } from "./helpers/seed";

const LONG = "a long cell that fills the line ".repeat(12);

// A rendered markdown table keeps every word whole: a short column is
// as wide as its longest word, however long its neighbours are.
test("a rendered markdown table keeps its words whole", async ({ page }) => {
  writeFixtureFile(
    "table.md",
    `# Table

| ID | Feedback | Comments |
| --- | --- | --- |
| B1 | ${LONG} | 120 |
`,
  );
  await authenticate(page, "/");
  // Earlier specs leave files above this one, out of the rendered rows.
  // It is the only markdown file, so its toggle is the only one.
  await page.getByRole("treeitem", { name: "table.md", exact: true }).click();
  await page
    .getByRole("radio", { name: "Rich" })
    .first()
    .dispatchEvent("click");
  const doc = page.locator(".markdown-doc table");
  await expect(doc).toBeVisible({ timeout: 10_000 });

  for (const word of ["ID", "Comments", "B1"]) {
    const cell = doc
      .locator("th, td")
      .filter({ hasText: new RegExp(`^${word}$`) });
    const lines = await cell.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
        .size;
    });
    expect(lines, word).toBe(1);
  }
});
