import type { Locator, Page } from "@playwright/test";

/**
 * Helpers for My Home, the one page that holds buildings, zones and rooms.
 * A zone's thermostat settings are a tab of its Edit Zone dialog, and a room's settings
 * behind its card's "Room Settings" button.
 */

export async function gotoMyHome(page: Page): Promise<void> {
  await page.goto("/my-home");
  await page.waitForSelector(".loading", {
    state: "detached",
    timeout: 15_000,
  });
  await page.waitForLoadState("networkidle");
}

/** The panel for one zone, found by its thermostat entity id. */
export function zonePanel(page: Page, entityId: string): Locator {
  // The entity id is the tooltip of the "Thermostat: …" line under the zone's name.
  return page
    .locator(".zone-panel")
    .filter({ has: page.locator(`.zone-entity[title="${entityId}"]`) })
    .first();
}

/**
 * Open a zone's editor (equipment + thermostat settings) and wait for the
 * thermostat card's inputs. Returns the zone panel.
 */
export async function openZoneEditor(
  page: Page,
  entityId: string,
): Promise<Locator> {
  const panel = zonePanel(page, entityId);
  await panel.getByRole("button", { name: "Edit Zone" }).click();
  // Edit Zone is one dialog with two tabs; the thermostat's settings are the
  // second.
  await page.getByRole("tab", { name: "Thermostat" }).click();
  await page.locator(`[id="thermo-${entityId}-name"]`).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  return panel;
}

/** The card for one room on My Home. */
export function roomCard(page: Page, roomName: string): Locator {
  return page.locator(".room-card").filter({ hasText: roomName }).first();
}

/** Open a room's settings page from its card. Returns the settings container. */
export async function openRoomSettings(
  page: Page,
  roomName: string,
): Promise<Locator> {
  await roomCard(page, roomName)
    .getByRole("button", { name: "Room Settings" })
    .click();
  const settings = page.getByTestId("room-settings");
  await settings.waitFor({ state: "visible", timeout: 10_000 });
  return settings;
}

/**
 * Open how a room is heated and cooled: Smart Control → Rooms → Change.
 * Returns the dialog, which closes when it saves.
 */
export async function openRoomTuning(
  page: Page,
  roomName: string,
): Promise<Locator> {
  await page.goto("/smart-control?section=rooms");
  await page
    .getByRole("button", { name: `Change ${roomName}`, exact: true })
    .click();
  const settings = page.getByTestId("room-settings");
  await settings.waitFor({ state: "visible", timeout: 10_000 });
  return settings;
}

/**
 * Open a room's occupied temperature: Dashboard → the room → When Occupied.
 * Returns that block. It stays open after a save and says "Saved".
 */
export async function openOccupied(
  page: Page,
  roomName: string,
): Promise<Locator> {
  await page.goto("/");
  await page.waitForSelector(".loading", {
    state: "detached",
    timeout: 15_000,
  });
  await page.waitForLoadState("networkidle");
  await page
    .getByRole("button", { name: `Details for ${roomName}`, exact: true })
    .click();
  const block = page.getByRole("region", { name: "When occupied" });
  await block.waitFor({ state: "visible", timeout: 10_000 });
  return block;
}

/** Save the When Occupied block and wait until it says so. */
export async function saveOccupied(block: Locator): Promise<void> {
  await block.getByRole("button", { name: "Save", exact: true }).click();
  await block.getByText("Saved", { exact: true }).waitFor({ timeout: 5_000 });
}
