import { expect, test } from "@playwright/test";
import {
  api,
  authenticate,
  cli,
  cliJSON,
  draftComment,
  git,
  readFixtureFile,
  writeFixtureFile,
} from "./helpers/seed";

const LAST_SEND = "refs/revue/last-send";

// Twelve lines, so an edit at the top and one at the bottom fall in
// different hunks.
function delta(changed: Record<number, string> = {}): string {
  const lines = ["package main", ""];
  for (let i = 3; i <= 14; i++) lines.push(changed[i] ?? `// delta line ${i}`);
  return lines.join("\n") + "\n";
}

// The loop with a self-review: the agent explains a line before the
// reviewer reads, the reviewer sends a comment, the agent changes that
// code and answers. The panel sorts it all by whose turn it is, the
// outdated thread stays under its file's header, and "Since my last
// send" shows only what the agent did after the send.
test("self-review, send, agent edit and answer, diff since the last send", async ({
  page,
}) => {
  writeFixtureFile("delta.go", delta());
  expect((await git(["add", "delta.go"])).code).toBe(0);
  expect((await git(["commit", "-q", "-m", "add delta"])).code).toBe(0);
  writeFixtureFile(
    "delta.go",
    delta({ 3: "// delta line 3 v2", 13: "// delta line 13 v2" }),
  );

  await authenticate(page, "/");
  await expect(page.getByText("delta line 13 v2").first()).toBeVisible({
    timeout: 10_000,
  });

  // The agent opens a thread of its own; it shows at once, inline.
  const note = await cli([
    "comment",
    "--path",
    "delta.go",
    "--line",
    "3",
    "-m",
    "renamed for the new API",
  ]);
  expect(note.code).toBe(0);
  const noteId = cliJSON<{ thread: { id: number } }>(note).thread.id;
  const noteCard = page.getByTestId(`thread-${noteId}`);
  await expect(noteCard.getByText("renamed for the new API")).toBeVisible();

  await page.getByRole("button", { name: /threads/ }).click();
  const panel = page.getByTestId("threads-panel");
  const yours = panel.getByTestId("panel-turn-yours");
  await expect(yours.getByTestId(`panel-thread-${noteId}`)).toContainText(
    "agent note",
  );

  // The reviewer comments and sends. The send records the working
  // tree under a ref and changes nothing in the checkout.
  await draftComment(page, "delta line 13 v2", "why v2 here?");
  const statusBefore = (await git(["status", "--porcelain"])).stdout;
  await page
    .getByTestId("send-composer")
    .getByRole("button", {
      name: "Send",
      exact: true,
    })
    .click();
  // Waiting on agent is folded while something is your turn.
  const waiting = panel.getByTestId("panel-turn-agent");
  const waitingHeader = waiting.getByRole("button", {
    name: /Waiting on agent/,
  });
  await expect(waitingHeader).toHaveAttribute("aria-expanded", "false");
  await waitingHeader.click();
  await expect(waiting).toContainText("why v2 here?");
  const ref = await git(["rev-parse", "--verify", "-q", LAST_SEND]);
  expect(ref.code).toBe(0);
  expect((await git(["status", "--porcelain"])).stdout).toBe(statusBefore);
  expect((await git(["show", `${LAST_SEND}:delta.go`])).stdout).toContain(
    "delta line 13 v2",
  );

  // The agent rewrites the commented line and answers.
  writeFixtureFile(
    "delta.go",
    readFixtureFile("delta.go").replace("delta line 13 v2", "delta line 13 v3"),
  );
  await expect(page.getByText("delta line 13 v3").first()).toBeVisible({
    timeout: 10_000,
  });
  const fb = cliJSON<{
    threads: { id: number; comments: { body: string }[] }[];
  }>(await cli(["feedback"]));
  const asked = fb.threads.find((t) => t.comments[0].body === "why v2 here?");
  expect(asked).toBeDefined();
  expect(
    (
      await cli([
        "reply",
        "--thread",
        String(asked!.id),
        "-m",
        "v3 now, v2 broke the build",
      ])
    ).code,
  ).toBe(0);

  // The reviewer's thread is outdated but still in the diff, under the
  // delta.go header, with the answer; the agent's note on the other
  // hunk stays inline. The panel puts the thread back in Your turn.
  const outdated = page.getByTestId(`outdated-${asked!.id}`);
  await expect(outdated).toContainText("Outdated · was on line 13");
  await expect(outdated).toContainText("v3 now, v2 broke the build");
  await expect(page.getByTestId(`outdated-${noteId}`)).toHaveCount(0);
  await expect(noteCard).toBeVisible();
  await expect(yours.getByTestId(`panel-thread-${asked!.id}`)).toContainText(
    "agent: v3 now, v2 broke the build",
  );
  await expect(waiting.getByTestId(`panel-thread-${asked!.id}`)).toHaveCount(0);

  // "Changes since" shows what the agent did to the file.
  await outdated
    .getByRole("button", { name: "Changes since" })
    .dispatchEvent("click");
  const view = page.getByTestId("snapshot-view");
  await expect(
    view.getByText("What changed since the thread started"),
  ).toBeVisible();
  await expect(view.getByText("delta line 13 v3").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);

  // The diff since the last send holds the agent's edit only: beta.go
  // did not change after the send, delta.go's top hunk neither.
  await page.getByRole("button", { name: "Change diff" }).click();
  await page.getByRole("button", { name: /Since my last send/ }).click();
  await expect(page).toHaveURL(/arg=refs%2Frevue%2Flast-send/);
  await expect(page.getByRole("button", { name: "Change diff" })).toContainText(
    "since last send",
  );
  const tree = page.getByLabel("Changed files");
  await expect(tree.getByText("1 file")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("delta line 13 v3").first()).toBeVisible();
  await expect(page.getByText("delta line 3 v2")).toHaveCount(0);
  await expect(page.getByTestId(`outdated-${asked!.id}`)).toBeVisible();
  // beta.go is out of this diff: its thread does not bring it back.
  await expect(page.getByTestId("gone-beta.go")).toHaveCount(0);

  // Specs share one server: leave the checkout as the next ones expect.
  for (const id of [noteId, asked!.id])
    await api("POST", `/api/threads/${id}/resolve`, {});
  expect((await git(["checkout", "--", "delta.go"])).code).toBe(0);
});
