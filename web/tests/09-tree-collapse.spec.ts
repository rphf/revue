import { expect, test } from "@playwright/test";
import { authenticate } from "./helpers/seed";

// The button in the top bar collapses the file tree to nothing and
// opens it back to the width it had; the choice survives a reload.
// Dragging its edge and ⌘B do the same.
test("the file tree collapses and opens back to its width", async ({
  page,
}) => {
  await authenticate(page, "/");
  const tree = page.locator("[data-panel]#tree");
  await expect(page.getByLabel("Changed files")).toBeVisible();
  const open = (await tree.boundingBox())?.width ?? 0;
  expect(open).toBeGreaterThan(150);

  await page.getByRole("button", { name: "Hide files" }).click();
  await expect.poll(async () => (await tree.boundingBox())?.width).toBe(0);
  const edge = page.locator("[data-separator]").first();
  await expect(edge).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await page.reload();
  await expect(page.getByRole("button", { name: "Show files" })).toBeVisible();
  await expect.poll(async () => (await tree.boundingBox())?.width).toBe(0);

  await page.getByRole("button", { name: "Show files" }).click();
  await expect
    .poll(async () => Math.round((await tree.boundingBox())?.width ?? 0))
    .toBe(Math.round(open));
  await expect(page.getByRole("button", { name: "Hide files" })).toBeVisible();

  // Dragging the edge past the tree's minimum collapses it too, and the
  // button follows.
  const box = await edge.boundingBox();
  if (!box) throw new Error("no separator");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(20, y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await tree.boundingBox())?.width).toBe(0);
  await expect(page.getByRole("button", { name: "Show files" })).toBeVisible();

  // ⌘B toggles it from the keyboard and ⌘I the threads, from inside a
  // text box too. The device's user agent is not a Mac's, so the page
  // expects Ctrl.
  await page.keyboard.press("Control+b");
  await expect(page.getByRole("button", { name: "Hide files" })).toBeVisible();
  await page.keyboard.press("Control+i");
  const note = page.getByLabel("Note to the agent");
  await note.fill("typing");
  await note.press("Control+b");
  await expect(page.getByRole("button", { name: "Show files" })).toBeVisible();
  await expect(note).toHaveValue("typing");
  await note.press("Control+i");
  await expect(note).not.toBeVisible();
});
