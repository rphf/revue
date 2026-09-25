import { expect, test } from "@playwright/test";
import { authenticate, writeFixtureFile } from "./helpers/seed";

// Everything reverted on disk: the page follows to the empty state in
// both the diff pane and the tree, without a reload.
test("a reverted working tree renders the empty state live", async ({
  page,
}) => {
  await authenticate(page, "/");
  await expect(page.getByText("beta two v2").first()).toBeVisible();

  // Restore both files to their committed contents (must mirror
  // tests/scripts/start-test-server.sh).
  writeFixtureFile(
    "alpha.go",
    `package main

func alpha() {
	println("alpha one")
	println("alpha two")
	println("alpha three v1")
	println("alpha four")
}
`,
  );
  writeFixtureFile(
    "beta.go",
    `package main

func beta() {
	println("beta one")
	println("beta two v1")
	println("beta three")
}
`,
  );

  await expect(page.getByTestId("diff-empty")).toHaveText(
    /No changes in this diff/,
    { timeout: 10_000 },
  );
  await expect(page.getByText("No changed files")).toBeVisible();

  // The open thread on alpha.go outlives its change: its file keeps a
  // header, marked as out of the diff, with the thread under it.
  await expect(page.getByTestId("gone-alpha.go")).toHaveText(
    "Not in this diff any more",
  );
  await expect(
    page.getByTestId(/^outdated-/).filter({ hasText: "alpha draft note" }),
  ).toBeVisible();
});
