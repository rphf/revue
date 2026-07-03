import { expect, test } from "@playwright/test";
import { authenticate, cli, cliJSON, writeFixtureFile } from "./helpers/seed";

// KTD12: everything reverted is a valid round and renders the empty
// state in both the diff pane and the tree.
test("empty-diff round renders the empty state", async ({ page }) => {
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

  const round = await cli(["round", "--review", "1"]);
  expect(round.code).toBe(0);
  const created = cliJSON<{ round: { seq: number }; deduped: boolean }>(round);
  expect(created.deduped).toBe(false);

  await authenticate(page, "/reviews/1");
  await expect(page.getByTestId("diff-empty")).toHaveText(/No changes in this diff/);
  await expect(page.getByText("No changed files")).toBeVisible();
});
