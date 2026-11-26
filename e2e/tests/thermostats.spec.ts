import { test, expect } from "./fixtures";
import { gotoMyHome, openZoneEditor } from "./my-home";

// Thermostat settings live inside their zone on My Home; there is no separate
// Thermostats page.
const DOWNSTAIRS = "climate.downstairs_thermostat";

test("thermostat settings inside a zone", async ({ page }) => {
  await gotoMyHome(page);
  await openZoneEditor(page, DOWNSTAIRS);
  await page.waitForLoadState("networkidle");

  await expect(page).toHaveScreenshot("thermostats.png", { fullPage: true });
});

test("zone delete confirmation dialog", async ({ page }) => {
  await gotoMyHome(page);
  const panel = await openZoneEditor(page, DOWNSTAIRS);

  await panel.getByRole("button", { name: "Delete Zone" }).click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  // Scope to the message <p>, not the whole dialog — the modal title
  // ("Delete zone?") also matches a loose "Delete zone" search.
  await expect(dialog.locator("p")).toContainText("and all of its rooms");

  await expect(page).toHaveScreenshot("thermostat-remove-confirm.png", { maxDiffPixels: 800 });

  // Cancel — don't actually delete a zone other specs depend on.
  await dialog.getByRole("button", { name: "Cancel" }).click();
});
