import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { api, authenticate, cli, REPO, writeFixtureFile } from "./helpers/seed";
import type { Thread } from "../src/types";

// A panel row with a new agent reply lands on that reply: the diff
// scrolls to it, outlines it, and shows it even when it was minimized.
test("a row with a new reply jumps to that reply, minimized or not", async ({
  page,
}) => {
  // A file of its own, so the edits of earlier specs cannot move it.
  const file = "jump.txt";
  writeFixtureFile(file, "one\ntwo\nthree\n");
  let id = 0;
  try {
    await expect
      .poll(async () =>
        (
          await api<{ files: { path: string }[] }>("GET", "/api/diff")
        ).files.map((f) => f.path),
      )
      .toContain(file);
    const note = await cli(["comment", `${file}:2`, "jump spec note"]);
    expect(note.code, note.stderr).toBe(0);
    id = Number(note.stdout.trim());
    const long = Array.from(
      { length: 40 },
      (_, i) => `jump spec reply line ${i + 1}`,
    ).join("\n\n");
    const reply = await cli(["reply", String(id), long]);
    expect(reply.code, reply.stderr).toBe(0);
    const { threads } = await api<{ threads: Thread[] }>("GET", "/api/threads");
    const replyId = threads.find((t) => t.id === id)!.comments.at(-1)!.id;

    await authenticate(page, "/");
    const comment = page.getByTestId(`comment-${replyId}`);
    await comment.getByRole("button", { name: "Minimize the comment" }).click();
    await expect(comment).toHaveAttribute("data-minimized");
    await page.locator(".diff-scroll").evaluate((el) => el.scrollTo(0, 0));

    await page.getByRole("button", { name: /threads/ }).click();
    await page.getByTestId(`panel-thread-${id}`).click();

    await expect(comment).toHaveAttribute("data-focused");
    // The reply is taller than the screen: it opens at its first line.
    const firstLine = comment.getByText("jump spec reply line 1", {
      exact: true,
    });
    await expect(firstLine).toBeVisible();
    await expect(firstLine).toBeInViewport();
    await expect(page.getByTestId(`thread-${id}`)).not.toHaveClass(
      /outline-primary/,
    );

    // A click on the reply keeps it; a click anywhere else, even on
    // its thread, ends the focus, and the reply minimizes again.
    // WebKit lays the scrolled diff out a moment after the jump; until
    // then a click at the reply lands on the diff's container.
    await expect
      .poll(() =>
        firstLine.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        }),
      )
      .toBe(true);
    await firstLine.click();
    await expect(comment).toHaveAttribute("data-focused");
    await page.getByTestId(`thread-${id}`).getByText("jump spec note").click();
    await expect(comment).toHaveAttribute("data-minimized");

    // The same from a click in the diff.
    await page.getByTestId(`panel-thread-${id}`).click();
    await expect(comment).toHaveAttribute("data-focused");
    await page.getByText("beta one").first().click();
    await expect(comment).toHaveAttribute("data-minimized");
  } finally {
    // Its long reply would stay in the diff as an outdated thread.
    if (id) await api("POST", "/api/threads/archive", { ids: [id] });
    fs.rmSync(path.join(REPO, file), { force: true });
  }
});
