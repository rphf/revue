import { expect, test } from "@playwright/test";
import { authenticate, cli, cliJSON, draftComment } from "./helpers/seed";

interface Feedback {
  threads: {
    id: number;
    comments: { body: string; authorRole: string }[];
    quote?: { path: string; lines: string[] };
  }[];
  lastSend: { note: string } | null;
}

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
  const before = cliJSON<Feedback>(await cli(["feedback"]));
  expect(before.threads).toHaveLength(0);
  expect(before.lastSend).toBeNull();

  await page.getByTestId("open-send").click();
  const composer = page.getByTestId("send-composer");
  await composer.getByLabel("Note to the agent").fill("one naming fix");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer.getByLabel("Note to the agent")).toHaveValue("");

  // The agent receives the comment, the quoted code and the note at once.
  const result = await cli(["feedback"]);
  expect(result.code).toBe(0);
  const fb = cliJSON<Feedback>(result);
  expect(fb.threads).toHaveLength(1);
  expect(fb.threads[0].comments[0].body).toBe(
    "use fmt.Println instead of println",
  );
  expect(fb.threads[0].quote?.path).toBe("alpha.go");
  expect(fb.threads[0].quote?.lines.join("\n")).toContain("alpha three v2");
  expect(fb.lastSend?.note).toBe("one naming fix");

  // The agent replies; the browser shows it without any reload.
  const reply = await cli([
    "reply",
    "--thread",
    String(fb.threads[0].id),
    "-m",
    "switched to fmt.Println",
  ]);
  expect(reply.code).toBe(0);
  const card = page.getByTestId(`thread-${fb.threads[0].id}`);
  await expect(card.getByText("switched to fmt.Println")).toBeVisible();
  await expect(card.getByText("agent", { exact: true })).toBeVisible();

  // The agent wrote last: the panel puts the thread under Your turn,
  // with the answer under the comment.
  const yours = page.getByTestId("panel-turn-yours");
  await expect(yours).toContainText("use fmt.Println instead of println");
  await expect(yours).toContainText("agent: switched to fmt.Println");
  await expect(page.getByTestId("panel-turn-agent")).toHaveCount(0);
});
