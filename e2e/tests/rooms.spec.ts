import { test, expect } from "./fixtures";
import { openRoomSettings } from "./my-home";

test("my home — buildings, zones and rooms", async ({ page }) => {
  await page.goto("/my-home");
  await page.waitForSelector(".loading", { state: "detached", timeout: 15_000 });
  await page.waitForLoadState("networkidle");

  // No masks: the room cards show hardware only, and their live values come
  // from the fixed-value fake sensors, so they are already stable. See #182.
  await expect(page).toHaveScreenshot("rooms.png", {
    fullPage: true,
  });
});

test("room detail — Living Room", async ({ page }) => {
  await page.goto("/my-home");
  await page.waitForSelector(".loading", { state: "detached", timeout: 15_000 });
  await page.waitForLoadState("networkidle");

  // Open the Living Room detail card / modal
  await page.getByText("Living Room").first().click();
  await page.waitForLoadState("networkidle");

  // Do NOT use fullPage: true here — on mobile the sticky <nav> is duplicated at each
  // viewport-slice boundary during Playwright's fullPage stitching, causing persistent
  // pixel instability. The viewport captures the expanded room detail which is what we
  // care about. No masks: the per-second countdown timers are frozen by the isCI
  // flag under the CI build. See issue #182.
  await expect(page).toHaveScreenshot("room-detail.png");
});

test("room delete confirmation dialog", async ({ page }) => {
  await page.goto("/my-home");
  await page.waitForSelector(".loading", { state: "detached", timeout: 15_000 });
  await page.waitForLoadState("networkidle");

  // Delete lives on the Room Settings page, not on the card.
  await openRoomSettings(page, "Living Room");
  await page.getByRole("button", { name: "Delete Room" }).click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  // Scope to the message <p>, not the whole dialog — the modal title
  // ("Delete room?") also matches a loose "Delete room" text search.
  await expect(dialog.locator("p")).toContainText("Delete room");

  await expect(page).toHaveScreenshot("room-delete-confirm.png", { maxDiffPixels: 800 });

  // Cancel — don't actually delete a room other specs depend on.
  await dialog.getByRole("button", { name: "Cancel" }).click();
});
