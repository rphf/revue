import { expect, test } from "@playwright/test";
import {
  authenticate,
  draftComment,
  readFixtureFile,
  writeFixtureFile,
} from "./helpers/seed";

// The diff follows the working tree: an edit on disk shows up without a
// reload. A draft on the changed hunk goes outdated and moves under its
// file's header, with the file as it was and the change since one click
// away; a draft on the unchanged hunk stays inline.
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

  // The beta draft is still inline; the alpha draft sits under the
  // alpha.go header, marked with the line it was on.
  await expect(page.getByText("beta draft note")).toBeVisible();
  const card = page
    .getByTestId(/^outdated-/)
    .filter({ hasText: "alpha draft note" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Outdated · was on line 6");

  // The panel lists it as outdated; a click scrolls to it, outlined,
  // without leaving the diff.
  await page.getByRole("button", { name: /threads/ }).click();
  const panel = page.getByTestId("threads-panel");
  await panel.getByRole("tab", { name: /outdated/ }).click();
  await panel.getByText("alpha draft note").click();
  await expect(card).toBeInViewport();
  await expect(card.getByTestId(/^thread-/)).toHaveAttribute(
    "data-focused",
    "true",
  );
  await expect(page.getByTestId("snapshot-view")).toHaveCount(0);

  // "As it was" shows the file as it was, with the draft on it, and
  // the panel still beside it.
  await card.getByRole("button", { name: "As it was" }).dispatchEvent("click");
  const view = page.getByTestId("snapshot-view");
  await expect(view).toBeVisible();
  await expect(view.getByText("alpha three v2").first()).toBeVisible();
  const thread = view
    .getByTestId(/^thread-/)
    .filter({ hasText: "alpha draft note" });
  await expect(thread).toBeVisible();
  await expect(view.getByTestId("snapshot-position")).toHaveText(
    /^\d+ of \d+ outdated$/,
  );
  await expect(panel).toBeVisible();

  // A reply shows on the snapshot at once.
  await thread
    .getByRole("button", { name: "Reply", exact: true })
    .dispatchEvent("click");
  await thread.getByPlaceholder("Reply").fill("alpha reply from snapshot");
  await thread
    .getByRole("button", { name: "Reply", exact: true })
    .dispatchEvent("click");
  await expect(thread.getByText("alpha reply from snapshot")).toBeVisible();

  // "Changes since" diffs the file then against the file now: the
  // agent's v2 -> v3, with the thread above it.
  await view.getByRole("radio", { name: "Changes since" }).click();
  await expect(
    view.getByText("What changed since the thread started"),
  ).toBeVisible();
  await expect(view.getByText("alpha three v3").first()).toBeVisible();
  await expect(view.getByTestId("snapshot-no-change")).toHaveCount(0);
  await expect(
    view.getByTestId(/^thread-/).filter({ hasText: "alpha draft note" }),
  ).toBeVisible();

  // Escape goes back to the diff.
  await page.keyboard.press("Escape");
  await expect(view).not.toBeVisible();

  // A live thread in the panel scrolls the diff to it, outlined.
  await panel.getByRole("tab", { name: /^all/ }).click();
  await panel.getByText("beta draft note").click();
  const beta = page
    .getByTestId(/^thread-/)
    .filter({ hasText: "beta draft note" });
  await expect(beta).toBeInViewport();
  await expect(beta).toHaveAttribute("data-focused", "true");

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
