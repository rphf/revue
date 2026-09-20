import { expect, test } from "@playwright/test";
import {
  authenticate,
  draftComment,
  readFixtureFile,
  writeFixtureFile,
} from "./helpers/seed";

// The diff follows the working tree: an edit on disk shows up without a
// reload. A draft on the changed hunk goes outdated and opens on the
// file as it was; a draft on the unchanged hunk stays inline.
test("an edit on disk updates the diff live and outdates the thread on its hunk", async ({
  page,
}) => {
  await authenticate(page, "/");
  await expect(page.getByText("alpha three v2").first()).toBeVisible();

  await draftComment(page, "alpha three v2", "alpha draft note");
  await draftComment(page, "beta two v2", "beta draft note");

  // The agent rewrites the alpha hunk while the drafts are pending.
  writeFixtureFile(
    "alpha.go",
    readFixtureFile("alpha.go").replace("alpha three v2", "alpha three v3"),
  );

  // The page follows within a poll tick.
  await expect(page.getByText("alpha three v3").first()).toBeVisible({
    timeout: 10_000,
  });

  // The beta draft is still inline; the alpha draft is not, but it is
  // not lost: the panel lists it as outdated.
  await expect(page.getByText("beta draft note")).toBeVisible();
  await expect(page.getByText("alpha draft note")).not.toBeVisible();
  await page.getByRole("button", { name: /threads/ }).click();
  const panel = page.getByTestId("threads-panel");
  await panel.getByRole("tab", { name: /outdated/ }).click();
  await expect(panel.getByText("alpha draft note")).toBeVisible();

  // Opening it shows the file as it was, with the draft on it.
  await panel.getByText("alpha draft note").click();
  const dialog = page.getByTestId("snapshot-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("alpha three v2").first()).toBeVisible();
  await expect(dialog.getByText("alpha draft note")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  // The live filter shows the beta draft only.
  await panel.getByRole("tab", { name: /^live/ }).click();
  await expect(panel.getByText("beta draft note")).toBeVisible();
  await expect(panel.getByText("alpha draft note")).not.toBeVisible();
});

test("threads panel partitions live, outdated, and resolved", async ({
  page,
}) => {
  await authenticate(page, "/");
  await expect(page.getByText("beta draft note")).toBeVisible();

  // Resolve the beta thread. The button sits in a virtualized
  // annotation; dispatch the click directly.
  await page
    .getByTestId(/^thread-/)
    .filter({ hasText: "beta draft note" })
    .getByRole("button", { name: "Resolve", exact: true })
    .dispatchEvent("click");
  await expect(
    page.getByText("Resolved", { exact: true }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: /threads/ }).click();
  const panel = page.getByTestId("threads-panel");

  await panel.getByRole("tab", { name: /resolved/ }).click();
  await expect(panel.getByText("beta draft note")).toBeVisible();

  // Resolved wins over live: it is out of the live partition now.
  await panel.getByRole("tab", { name: /^live/ }).click();
  await expect(panel.getByText("beta draft note")).not.toBeVisible();

  await panel.getByRole("tab", { name: /outdated/ }).click();
  await expect(panel.getByText("alpha draft note")).toBeVisible();
});
