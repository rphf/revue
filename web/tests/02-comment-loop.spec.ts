import { expect, test } from "@playwright/test";
import { authenticate, cli, draftComment, threadIds } from "./helpers/seed";

// Drafts stay invisible until the reviewer sends; then the agent's read
// returns everything at once with the note. The agent's reply appears
// live, without reload.
test("draft -> send with a note -> CLI feedback -> live agent reply", async ({
  page,
}) => {
  await authenticate(page, "/");
  await expect(page.getByText("alpha three v2").first()).toBeVisible();

  await draftComment(
    page,
    "alpha three v2",
    "use fmt.Println instead of println",
  );
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

  // The agent sees nothing before the send.
  const before = await cli(["feedback"]);
  expect(before.stdout).toBe("cursor 0\n");

  await page.getByTestId("open-send").click();
  const composer = page.getByTestId("send-composer");
  await composer.getByLabel("Note to the agent").fill("one naming fix");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer.getByLabel("Note to the agent")).toHaveValue("");

  // The agent receives the comment, the quoted code and the note at once.
  const result = await cli(["feedback"]);
  expect(result.code).toBe(0);
  const [id] = threadIds(result);
  expect(threadIds(result)).toHaveLength(1);
  expect(result.stdout).toContain(`\n#${id} alpha.go:6\n`);
  expect(result.stdout).toContain('\n  | \tprintln("alpha three v2")\n');
  expect(result.stdout).toContain(
    "\nreviewer: use fmt.Println instead of println\n",
  );
  expect(result.stdout).toContain("\nnote: one naming fix\n");

  // The agent replies; the browser shows it without any reload.
  const reply = await cli(["reply", String(id), "switched to fmt.Println"]);
  expect(reply.code).toBe(0);
  const card = page.getByTestId(`thread-${id}`);
  await expect(card.getByText("switched to fmt.Println")).toBeVisible();
  await expect(card.getByText("agent", { exact: true })).toBeVisible();

  // The agent wrote last: the panel puts the thread under Your turn,
  // with the answer under the comment.
  const yours = page.getByTestId("panel-turn-yours");
  await expect(yours).toContainText("use fmt.Println instead of println");
  await expect(yours).toContainText("agent: switched to fmt.Println");
  await expect(page.getByTestId("panel-turn-agent")).toHaveCount(0);
});
