import { expect, test } from "@playwright/test";
import { authenticate, cli, cliJSON, draftComment } from "./helpers/seed";

interface Feedback {
  verdict: string;
  threads: {
    id: number;
    comments: { body: string; authorRole: string }[];
    quote?: { path: string; lines: string[] };
  }[];
}

// Covers AE3 end-to-end: drafts stay invisible until the reviewer
// submits with a verdict; then the agent's read returns everything at
// once. Then the agent's reply appears live, without reload.
test("draft -> submit with verdict -> CLI feedback -> live agent reply", async ({ page }) => {
  await authenticate(page, "/reviews/1");
  await expect(page.getByText("alpha three v2").first()).toBeVisible();

  await draftComment(page, "alpha.go", "alpha three v2", "use fmt.Println instead of println");
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

  // AE3 first half: the agent sees nothing before submission.
  const before = cliJSON<Feedback>(await cli(["feedback", "--review", "1"]));
  expect(before.threads).toHaveLength(0);

  // Submit with request_changes.
  await page.getByTestId("open-submit").click();
  const dialog = page.getByRole("dialog", { name: "Submit review" });
  await dialog.getByLabel(/Request changes/).check();
  await dialog.getByPlaceholder(/Summary/).fill("one naming fix");
  await dialog.getByRole("button", { name: "Submit review" }).click();
  await expect(dialog).not.toBeVisible();

  // AE3 second half: the agent receives comments + verdict at once,
  // with quoted snapshot context (R10, R13).
  const result = await cli(["feedback", "--review", "1"]);
  expect(result.code).toBe(0);
  const fb = cliJSON<Feedback>(result);
  expect(fb.verdict).toBe("request_changes");
  expect(fb.threads).toHaveLength(1);
  expect(fb.threads[0].comments[0].body).toBe("use fmt.Println instead of println");
  expect(fb.threads[0].quote?.path).toBe("alpha.go");
  expect(fb.threads[0].quote?.lines.join("\n")).toContain("alpha three v2");

  // The agent replies; the browser shows it without any reload (R7).
  const reply = await cli(["reply", "--thread", String(fb.threads[0].id), "-m", "switched to fmt.Println"]);
  expect(reply.code).toBe(0);
  await expect(page.getByText("switched to fmt.Println")).toBeVisible();
  await expect(page.getByText("agent", { exact: true })).toBeVisible();
});
