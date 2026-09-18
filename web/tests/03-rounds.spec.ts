import { expect, test } from "@playwright/test";
import {
  authenticate,
  cli,
  cliJSON,
  draftComment,
  readFixtureFile,
  writeFixtureFile,
} from "./helpers/seed";

// Covers AE7 end-to-end: unsubmitted drafts survive a new round —
// live on unchanged hunks, outdated on changed ones, none lost, and
// round creation never blocks. Plus the threads panel partition.
test("round 2 carries drafts: unchanged hunk live, changed hunk outdated", async ({
  page,
}) => {
  await authenticate(page, "/reviews/1");
  await expect(page.getByText("alpha three v2").first()).toBeVisible();

  // Two unsubmitted drafts: one on the alpha hunk (about to change),
  // one on the beta hunk (stays identical).
  await draftComment(page, "alpha.go", "alpha three v2", "alpha draft note");
  await draftComment(page, "beta.go", "beta two v2", "beta draft note");

  // The agent rewrites the alpha hunk and signals round 2 while the
  // reviewer's drafts are still pending.
  writeFixtureFile(
    "alpha.go",
    readFixtureFile("alpha.go").replace("alpha three v2", "alpha three v3"),
  );
  const round = await cli(["round", "--review", "1"]);
  expect(round.code).toBe(0);
  const created = cliJSON<{ round: { seq: number }; deduped: boolean }>(round);
  expect(created.round.seq).toBe(2);
  expect(created.deduped).toBe(false);

  // The UI follows to round 2 live (R7): new content appears.
  await expect(page.getByText("alpha three v3").first()).toBeVisible();

  // The beta draft is still attached inline (live anchor).
  await expect(page.getByText("beta draft note")).toBeVisible();

  // The alpha draft is not inline anymore, but it is NOT lost: the
  // panel lists it as outdated, linked to its origin round (R22).
  await expect(page.getByText("alpha draft note")).not.toBeVisible();
  await page.getByRole("button", { name: /threads/ }).click();
  const panel = page.getByTestId("threads-panel");
  await panel.getByRole("tab", { name: /outdated/ }).click();
  await expect(panel.getByText("alpha draft note")).toBeVisible();

  // Live filter shows the beta draft thread.
  await panel.getByRole("tab", { name: /^live/ }).click();
  await expect(panel.getByText("beta draft note")).toBeVisible();
  await expect(panel.getByText("alpha draft note")).not.toBeVisible();
});

test("threads panel partitions live, outdated, and resolved", async ({
  page,
}) => {
  await authenticate(page, "/reviews/1");
  await expect(page.getByText("beta draft note")).toBeVisible();

  // Resolve the beta thread (reviewer-only action, R6). The button
  // sits in a virtualized annotation; dispatch the click directly.
  await page
    .getByRole("button", { name: "Resolve", exact: true })
    .first()
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
