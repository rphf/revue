import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { authenticate, cli, REPO, writeFixtureFile } from "./helpers/seed";

// The agent's note is a button in the top bar as soon as it is written;
// it opens as a layer over the diff, says when the code moved on after
// it, and goes when the agent clears it.
test("the agent note shows live, goes outdated, and clears", async ({
  page,
}) => {
  await authenticate(page, "/");
  const button = page.getByRole("button", { name: "Agent note", exact: true });
  await expect(button).toHaveCount(0);

  const written = await cli(["note", "## Checked\n\n- unit tests pass"]);
  expect(written.code, written.stderr).toBe(0);
  await button.click();
  const body = page.getByTestId("agent-note-view");
  await expect(body.getByRole("heading", { name: "Checked" })).toBeVisible();
  await expect(body.getByText(/code changed since/i)).toHaveCount(0);

  // The file goes at the end, so specs after this one see the same diff.
  const changed = "note-outdated.txt";
  writeFixtureFile(changed, "a change after the note\n");
  try {
    await expect(body.getByText(/code changed since this note/i)).toBeVisible();
  } finally {
    fs.rmSync(path.join(REPO, changed), { force: true });
  }

  const cleared = await cli(["note", "--clear"]);
  expect(cleared.code, cleared.stderr).toBe(0);
  await expect(button).toHaveCount(0);
  await expect(body).toHaveCount(0);
});

// The note lies over the diff: opening and closing it, from the button,
// its corner, N or Escape, leaves the diff exactly where it was.
test("opening the note leaves the diff where it was", async ({ page }) => {
  const written = await cli(["note", "- a line\n".repeat(30)]);
  expect(written.code, written.stderr).toBe(0);
  try {
    await authenticate(page, "/");
    const scroller = page.locator(".diff-scroll");
    await expect(
      page.getByRole("button", { name: "Agent note", exact: true }),
    ).toBeVisible();
    await scroller.evaluate((el) => el.scrollTo(0, 200));
    const before = await scroller.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(0);

    const body = page.getByTestId("agent-note-view");
    const button = page.getByRole("button", {
      name: "Agent note",
      exact: true,
    });
    await button.click();
    await expect(body).toBeVisible();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Close the agent note" }).click();
    await expect(body).toHaveCount(0);
    await button.click();
    await button.click();
    await expect(body).toHaveCount(0);
    await button.click();
    await page.keyboard.press("Escape");
    await expect(body).toHaveCount(0);

    await page.keyboard.press("n");
    await expect(body).toBeVisible();
    await page.keyboard.press("n");
    await expect(body).toHaveCount(0);

    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before);
  } finally {
    await cli(["note", "--clear"]);
  }
});
