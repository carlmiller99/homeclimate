import { test, expect } from "./fixtures";

// The Settings page has a side menu of sections. General holds the house time
// zone and Backup & Restore; Integrations holds the MCP server toggle + inline
// setup guidance (#471) and the MQTT bridge. (The MCP access-token card only renders when
// require_auth is on — that's the @auth leg, captured by auth.spec.ts — so it
// is absent here.) This replaced the old capture that screenshotted the
// per-thermostat settings panel under the same `settings.png` name.
test("settings page — general", async ({ page }) => {
  await page.goto("/settings");
  await page.waitForSelector(".loading", {
    state: "detached",
    timeout: 15_000,
  });
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("timezone-card")).toBeVisible();

  await expect(page).toHaveScreenshot("settings-general.png", {
    fullPage: true,
  });
});

test("settings page — integrations", async ({ page }) => {
  await page.goto("/settings?section=integrations");
  await page.waitForSelector(".loading", {
    state: "detached",
    timeout: 15_000,
  });
  await page.waitForLoadState("networkidle");
  // Exact match: "MCP server" also appears as a substring in the page subtitle
  // and in the setup-guidance <dd>, so a plain getByText is a strict-mode
  // violation (3 matches).
  await expect(page.getByText("MCP server", { exact: true })).toBeVisible();

  await expect(page).toHaveScreenshot("settings.png", { fullPage: true });
});
