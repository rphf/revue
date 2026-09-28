import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { authenticate, cli, REPO, writeFixtureFile } from "./helpers/seed";

// The agent's note shows above the diff as it is written, says when the
// code moved on after it, and goes when the agent clears it.
test("the agent note shows live, goes outdated, and clears", async ({
  page,
}) => {
  await authenticate(page, "/");
  const bar = page.getByTestId("agent-note");
  await expect(bar).toHaveCount(0);

  const written = await cli(["note", "## Checked\n\n- unit tests pass"]);
  expect(written.code, written.stderr).toBe(0);
  await expect(bar).toContainText("Agent note");
  await expect(
    page
      .getByTestId("agent-note-body")
      .getByRole("heading", { name: "Checked" }),
  ).toBeVisible();
  await expect(bar.getByText(/code changed since/i)).toHaveCount(0);

  // The file goes at the end, so specs after this one see the same diff.
  const changed = "note-outdated.txt";
  writeFixtureFile(changed, "a change after the note\n");
  try {
    await expect(bar.getByText(/code changed since this note/i)).toBeVisible();
  } finally {
    fs.rmSync(path.join(REPO, changed), { force: true });
  }

  const cleared = await cli(["note", "--clear"]);
  expect(cleared.code, cleared.stderr).toBe(0);
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId("agent-note-body")).toHaveCount(0);
});

// The body scrolls with the diff under the bar, which stays; the bar
// collapses and expands the note from anywhere.
test("the note body scrolls with the diff and the bar stays", async ({
  page,
}) => {
  const written = await cli(["note", "- a line\n".repeat(12)]);
  expect(written.code, written.stderr).toBe(0);
  try {
    await authenticate(page, "/");
    const bar = page.getByTestId("agent-note");
    const body = page.getByTestId("agent-note-body");
    const scroller = page.locator(".diff-scroll");
    await expect(scroller.getByTestId("agent-note-body")).toBeVisible();
    const barTop = (await bar.boundingBox())!.y;

    await scroller.evaluate((el) => el.scrollTo(0, 150));
    await expect.poll(async () => (await bar.boundingBox())!.y).toBe(barTop);
    await expect
      .poll(async () => (await body.boundingBox())!.y)
      .toBeLessThan(barTop);

    await bar.getByRole("button", { name: "Collapse the agent note" }).click();
    await expect(body).toHaveCount(0);
    await bar.getByRole("button", { name: "Expand the agent note" }).click();
    await expect(body).toBeVisible();
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
  } finally {
    await cli(["note", "--clear"]);
  }
});

// Scrolls the diff 60px into its first file and names it: the list
// mounts only the files near the view, so "the first one" changes.
function intoFirstFile(scroller: Locator) {
  return scroller.evaluate((el) => {
    const host = el.querySelector("diffs-container")!;
    el.scrollTop +=
      host.getBoundingClientRect().top - el.getBoundingClientRect().top + 60;
    return host.shadowRoot!.querySelector("[data-diffs-header]")!.textContent!;
  });
}

// Where that file's header is once it holds still across frames.
async function headerTop(scroller: Locator, name: string) {
  const top = () =>
    scroller.evaluate((el, name) => {
      for (const host of el.querySelectorAll("diffs-container")) {
        const header = host.shadowRoot?.querySelector("[data-diffs-header]");
        if (header?.textContent === name) {
          return Math.round(header.getBoundingClientRect().top);
        }
      }
      return null;
    }, name);
  let last = await top();
  for (;;) {
    await scroller.page().waitForTimeout(50);
    const next = await top();
    if (next !== null && next === last) return next;
    last = next;
  }
}

// The note answers after the diff on a reload: the restored position
// still shows the code it showed.
test("a reload with a note keeps the diff's scroll position", async ({
  page,
}) => {
  const written = await cli(["note", "- a line\n".repeat(20)]);
  expect(written.code, written.stderr).toBe(0);
  try {
    await authenticate(page, "/");
    const scroller = page.locator(".diff-scroll");
    await expect(scroller.getByTestId("agent-note-body")).toBeVisible();
    const file = await intoFirstFile(scroller);
    const before = await headerTop(scroller, file);
    // The position is saved a moment after the scroll stops.
    await page.waitForTimeout(500);

    await page.route("**/api/note", async (route) => {
      await new Promise((r) => setTimeout(r, 1000));
      await route.continue();
    });
    await page.reload();
    await expect(scroller.getByTestId("agent-note-body")).toBeAttached();
    expect(await headerTop(scroller, file)).toBe(before);
  } finally {
    await cli(["note", "--clear"]);
  }
});
