import { expect, test, type Locator, type Page } from "@playwright/test";
import { authenticate } from "./helpers/seed";

async function width(pane: Locator): Promise<number> {
  return Math.round((await pane.boundingBox())?.width ?? 0);
}

async function drag(page: Page, edge: Locator, dx: number): Promise<void> {
  const box = await edge.boundingBox();
  if (!box) throw new Error("no separator");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

// Dragged widths survive a reload, and opening or closing the threads
// takes its room from the diff, never from the tree.
test("pane widths are kept across reloads and the threads toggle", async ({
  page,
}) => {
  await authenticate(page, "/");
  const tree = page.locator("[data-panel]#tree");
  await expect(page.getByLabel("Changed files")).toBeVisible();
  const start = await width(tree);
  await drag(page, page.locator('[data-slot="resizable-handle"]').first(), 80);
  await expect.poll(() => width(tree)).toBeGreaterThan(start + 60);
  const treeWidth = await width(tree);

  await page.getByRole("button", { name: "Show threads" }).click();
  const threads = page.locator("[data-panel]#threads");
  await expect(threads).toBeVisible();
  expect(Math.abs((await width(tree)) - treeWidth)).toBeLessThanOrEqual(1);

  const threadsStart = await width(threads);
  await drag(page, page.locator('[data-slot="resizable-handle"]').last(), -60);
  await expect.poll(() => width(threads)).toBeGreaterThan(threadsStart + 40);
  const threadsWidth = await width(threads);

  await page.reload();
  await expect(threads).toBeVisible();
  await expect.poll(() => width(tree)).toBe(treeWidth);
  await expect.poll(() => width(threads)).toBe(threadsWidth);

  await page.getByRole("button", { name: "Hide threads" }).click();
  await expect(threads).toHaveCount(0);
  expect(Math.abs((await width(tree)) - treeWidth)).toBeLessThanOrEqual(1);

  // Opened again, the threads come back at the dragged width.
  await page.getByRole("button", { name: "Show threads" }).click();
  await expect.poll(() => width(threads)).toBe(threadsWidth);
});
