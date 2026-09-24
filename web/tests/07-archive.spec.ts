import { expect, test } from "@playwright/test";
import {
  api,
  authenticate,
  draftComment,
  git,
  writeFixtureFile,
} from "./helpers/seed";

// A commit ends a conversation: the page offers to archive the threads
// whose code landed, and History keeps them under that commit.
test("a commit lands a thread, archiving moves it to History", async ({
  page,
}) => {
  writeFixtureFile(
    "gamma.go",
    'package main\n\nfunc gamma() {\n\tprintln("gamma one")\n}\n',
  );
  await authenticate(page, "/");
  await expect(page.getByText("gamma one").first()).toBeVisible({
    timeout: 10_000,
  });
  await draftComment(page, "gamma one", "archive spec note");
  await api("POST", "/api/send", { note: "" });

  expect((await git(["add", "gamma.go"])).code).toBe(0);
  expect((await git(["commit", "-q", "-m", "add gamma"])).code).toBe(0);

  await page.getByRole("button", { name: /threads/ }).click();
  const panel = page.getByTestId("threads-panel");
  const offer = panel.getByTestId("landed-offer");
  await expect(offer).toContainText("landed in", { timeout: 10_000 });
  await offer.getByRole("button", { name: /Archive/ }).click();
  await expect(offer).toHaveCount(0);
  await expect(panel.getByText("archive spec note")).toHaveCount(0);

  await panel.getByRole("radio", { name: "History" }).click();
  const history = panel.getByTestId("history-view");
  await expect(history.getByText("add gamma")).toBeVisible();
  await history.getByText("archive spec note").click();

  const snapshot = page.getByTestId("snapshot-view");
  await expect(snapshot.getByText("Archived")).toBeVisible();
  await expect(snapshot.getByText("archive spec note")).toBeVisible();
});
