import { expect, test } from "@playwright/test";
import { api, authenticate } from "./helpers/seed";

// `revue open` on a diff that already has a tab asks that tab to come
// forward; with permission, the tab raises a notification.
test("a focus notice raises a notification in a background tab", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const shown: string[] = [];
    (window as unknown as { shown: string[] }).shown = shown;
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        shown.push(`${title}: ${options?.body ?? ""}`);
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification });
    document.hasFocus = () => false;
  });
  await authenticate(page, "/");
  await expect(page.getByRole("button", { name: /threads/ })).toBeVisible();

  await expect(async () => {
    const { pages } = await api<{ pages: number }>("POST", "/api/focus");
    expect(pages).toBeGreaterThan(0);
  }).toPass({ timeout: 5_000 });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { shown: string[] }).shown),
    )
    .toHaveLength(1);
});
