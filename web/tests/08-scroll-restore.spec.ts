import { expect, test } from "@playwright/test";
import { authenticate, writeFixtureFile } from "./helpers/seed";

// A reload lands where the reviewer was in the diff.
test("a reload keeps the diff's scroll position", async ({ page }) => {
  const lines = Array.from({ length: 400 }, (_, i) => `// long line ${i + 1}`);
  writeFixtureFile("long.go", `package main\n\n${lines.join("\n")}\n`);
  await authenticate(page, "/");
  await expect(page.getByText("long line 12").first()).toBeVisible({
    timeout: 10_000,
  });

  const scroller = page.locator(".diff-scroll");
  await scroller.evaluate((el) => el.scrollTo({ top: 3000 }));
  const before = await scroller.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(2000);
  // Saving is debounced.
  await page.waitForTimeout(400);

  await page.reload();
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 10_000 })
    .toBeGreaterThan(before - 5);
  const after = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(5);
});
