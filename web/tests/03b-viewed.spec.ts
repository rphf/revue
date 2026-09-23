import { expect, test } from "@playwright/test";
import { authenticate, draftComment } from "./helpers/seed";

// The Viewed box in a file's header collapses the file to its header;
// a jump to a thread in that file opens it again and keeps it viewed.
test("a viewed file collapses and a jump to its thread opens it", async ({
  page,
}) => {
  await authenticate(page, "/");
  await expect(page.getByText("beta two v2").first()).toBeVisible();
  await draftComment(page, "beta two v2", "viewed spec note");

  const box = page.getByRole("checkbox", { name: "Viewed beta.go" });
  await box.check();
  await expect(page.getByText("beta two v2").first()).not.toBeVisible();
  await expect(page.getByText("viewed spec note")).not.toBeVisible();
  await expect(box).toBeChecked();

  await page.getByRole("button", { name: /threads/ }).click();
  const panel = page.getByTestId("threads-panel");
  await panel.getByText("viewed spec note").click();

  await expect(page.getByText("beta two v2").first()).toBeVisible();
  await expect(
    page.locator("[data-thread-id]").getByText("viewed spec note"),
  ).toBeVisible();
  await expect(box).toBeChecked();

  // Ticking again collapses it; the tree still counts it as viewed.
  await box.uncheck();
  await box.check();
  await expect(page.getByText("beta two v2").first()).not.toBeVisible();
  await expect(page.getByText(/1 viewed/)).toBeVisible();

  // The arrow before the name opens it without unticking it, and
  // collapses it again.
  await page.getByRole("button", { name: "Expand beta.go" }).click();
  await expect(page.getByText("beta two v2").first()).toBeVisible();
  await expect(box).toBeChecked();
  await page.getByRole("button", { name: "Collapse beta.go" }).click();
  await expect(page.getByText("beta two v2").first()).not.toBeVisible();
});
