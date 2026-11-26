import { test, expect } from "./fixtures";
import { gotoMyHome, openZoneEditor } from "./my-home";

/**
 * Round-trip regression for the temperature-unit conversion contract (#231).
 *
 * The bug this exercises: in Celsius mode, the frontend used to convert °C →
 * °F via `toStorage` before POSTing, AND the backend's `_to_f` converted again
 * — so a user typing "16" (°C) ended up with 141.44°F persisted instead of
 * 60.8°F. The fix pushed conversion entirely to the backend (Option A in the
 * issue): the frontend sends display-unit values as-is.
 *
 * The double-conversion was invisible to per-side unit tests (frontend tests
 * asserted "POSTs the pre-converted °F"; backend tests asserted "GET returns
 * °F when given °C") — only an end-to-end round-trip exposes it.
 *
 * This spec is parameterised on HOMECLIMATE_TEMP_UNIT (set by the CI matrix) so
 * the same assertions run under both °F and °C stacks. Under °F the round-trip
 * is trivial (no conversion); under °C it is the regression test.
 *
 * Coverage discipline: every test below tags itself with a `// @covers:` line
 * naming the backend field(s) it round-trips. `temperature-fields.ts` is the
 * single source of truth for the field list, and
 * `backend/tests/test_temperature_field_parity.py` asserts every UI-writable
 * entry is mentioned in at least one `@covers:` here. Add a field, add a tag.
 */

const UNIT = (process.env.HOMECLIMATE_TEMP_UNIT ?? "F") as "F" | "C";
const isCelsius = UNIT === "C";

// Values chosen so the °C number is comfortable in the field's valid range
// and round-trips cleanly through the backend's 2dp °F storage. Each pair
// is { °F input when in F mode, °C input when in C mode }.
const MIN_SETPOINT = isCelsius ? "17" : "62";
const MAX_SETPOINT = isCelsius ? "26" : "78";
const DEADBAND = isCelsius ? "0.5" : "0.9";
const OVERSHOOT_DELTA = isCelsius ? "0.3" : "0.5";
const DEFAULT_TEMP = isCelsius ? "22" : "72";
const COOLING_LOCKOUT = isCelsius ? "12" : "54";
const SCHEDULE_TARGET = isCelsius ? "20" : "68";
// Schedule deadband override (Issue #517). A DELTA, so it scales by 9/5 with
// no +32 offset: 1°C ≡ 1.8°F, which round-trips exactly through 2dp storage.
const SCHEDULE_DRIFT = isCelsius ? "1" : "1.8";
const ROOM_SYS_TEMP = isCelsius ? "21" : "70";
// Temporary hold target (#576). Same endpoint family as the schedule target
// (both are `target_temp`, converted by `_to_f`), but a separate write path —
// the HoldModal POSTs to /api/rooms/{id}/override. 20°C ≡ 68°F round-trips
// cleanly through 2dp °F storage and sits well inside the 40–90°F hold bound.
const HOLD_TARGET = isCelsius ? "20" : "68";
const ROOM_TEMP_OFFSET = isCelsius ? "0.5" : "0.9";
// Per-room deadband override (Issue #277). A delta, so it round-trips through
// the backend's 2dp °F storage cleanly at 0.5°C → 0.9°F.
const ROOM_DEADBAND_OVERRIDE = isCelsius ? "0.5" : "0.9";
// Ambient pre-cool/pre-heat deltas (Issue #248). 5°C → 9.0°F and 3°C → 5.4°F
// both round-trip cleanly through the backend's 2dp °F storage, and the
// widened deadband (3) clears any thermostat deadband set earlier in this file.
const HOUSE_HEAT_TO = isCelsius ? "19.5" : "67";
const HOUSE_COOL_TO = isCelsius ? "24" : "75";
const AMBIENT_MIN_DIFF = isCelsius ? "5" : "5";
const AMBIENT_DEADBAND = isCelsius ? "3" : "3";

// Eco Mode (Issue #404). Outdoor thresholds / full-drift temps are absolute;
// max-drift and hysteresis are deltas. Every value round-trips cleanly through
// the backend's 2dp °F storage. Keyed by the field-name suffix used in the
// input ids so both the thermostat and room round-trips share one map. The
// numeric fields are editable without turning Eco on (only the toggle needs an
// outside sensor), so these round-trips do not configure one.
const ECO_VALUES: Record<string, string> = {
  eco_cooling_outdoor_threshold: isCelsius ? "31" : "88",
  eco_cooling_full_drift_temp: isCelsius ? "39" : "102",
  eco_cooling_max_drift: isCelsius ? "2" : "4",
  eco_heating_outdoor_threshold: isCelsius ? "3" : "38",
  eco_heating_full_drift_temp: isCelsius ? "-17" : "2",
  eco_heating_max_drift: isCelsius ? "2" : "4",
  eco_hysteresis_band: isCelsius ? "1" : "2",
};

// The seeded thermostat global-setup registers first. Use its specific id to
// avoid strict-mode collisions with the second thermostat ("upstairs").
const TC_ID = "climate.downstairs_thermostat";

test.describe(`Temperature round-trip (HOMECLIMATE_TEMP_UNIT=${UNIT})`, () => {
  test("thermostat fields persist exactly as entered (#231)", async ({
    page,
  }) => {
    // @covers: default_temp, min_setpoint, max_setpoint, deadband, overshoot_delta, cooling_lockout_below_f
    // Thermostat settings live inside their zone on My Home.
    await gotoMyHome(page);
    await openZoneEditor(page, TC_ID);

    // Target the specific downstairs card by its unique input id. Two
    // thermostats are seeded, so unscoped label/role lookups would hit
    // strict-mode violations. Use [id="…"] (attribute selector) rather
    // than `#…` (CSS id selector) because the entity_id embeds a dot
    // (climate.downstairs_thermostat), which `#` treats as a class
    // separator.
    const idSel = (suffix: string) => `[id="thermo-${TC_ID}-${suffix}"]`;
    const card = page
      .locator(idSel("name"))
      .locator("xpath=ancestor::*[contains(@class,'card')][1]");

    await page.locator(idSel("default_temp")).fill(DEFAULT_TEMP);
    await page.locator(idSel("min_setpoint")).fill(MIN_SETPOINT);
    await page.locator(idSel("max_setpoint")).fill(MAX_SETPOINT);
    await page.locator(idSel("deadband")).fill(DEADBAND);
    await page.locator(idSel("overshoot_delta")).fill(OVERSHOOT_DELTA);
    // cooling_lockout_below_f uses a different id-suffix convention (`-cooling-lockout`,
    // hyphenated) because it was added separately from the SAFETY_FIELDS loop.
    await page
      .locator(`[id="thermo-${TC_ID}-cooling-lockout"]`)
      .fill(COOLING_LOCKOUT);

    // Capture the PUT response — when this assertion fails the body text
    // surfaces the actual backend error (range/validation/etc) instead of
    // an opaque "Saved! never appeared" timeout.
    const putResponse = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/thermostats/${TC_ID}`) &&
        r.request().method() === "PUT",
    );
    await card.getByRole("button", { name: "Save changes" }).click();
    const response = await putResponse;
    const responseText = await response.text();
    expect(
      response.status(),
      `PUT /api/thermostats/${TC_ID} failed: ${responseText}`,
    ).toBeLessThan(400);

    // Reload and read back. The fix means each input should show the same
    // value that was typed; the double-conversion bug would surface as a
    // value off by the °C↔°F conversion factor.
    await page.reload();
    await page.waitForSelector(".loading", {
      state: "detached",
      timeout: 15_000,
    });
    await page.waitForLoadState("networkidle");
    await openZoneEditor(page, TC_ID);

    const readBack = async (suffix: string) =>
      parseFloat(
        await page.locator(`[id="thermo-${TC_ID}-${suffix}"]`).inputValue(),
      );

    expect(await readBack("default_temp")).toBeCloseTo(
      parseFloat(DEFAULT_TEMP),
      1,
    );
    expect(await readBack("min_setpoint")).toBeCloseTo(
      parseFloat(MIN_SETPOINT),
      1,
    );
    expect(await readBack("max_setpoint")).toBeCloseTo(
      parseFloat(MAX_SETPOINT),
      1,
    );
    expect(await readBack("deadband")).toBeCloseTo(parseFloat(DEADBAND), 1);
    expect(await readBack("overshoot_delta")).toBeCloseTo(
      parseFloat(OVERSHOOT_DELTA),
      1,
    );
    expect(await readBack("cooling-lockout")).toBeCloseTo(
      parseFloat(COOLING_LOCKOUT),
      1,
    );
  });

  test("room presence temp and offset persist exactly as entered (#231)", async ({
    page,
  }) => {
    // @covers: system_wide_temp, temp_offset, deadband_override
    await page.goto("/my-home");
    await page.waitForSelector(".loading", {
      state: "detached",
      timeout: 15_000,
    });
    await page.waitForLoadState("networkidle");

    // Open the Living Room's settings page. Scope to the room card — the
    // bare `getByRole("button", { name: /Settings/i })` also matches the
    // gear in the top nav (aria-label="Settings"), which is the wrong target.
    // Settings is now a full-page view (not a modal); target its container.
    const openSettings = async () => {
      await page
        .locator(".card")
        .filter({ hasText: "Living Room" })
        .first()
        .getByRole("button", { name: "Room Settings" })
        .click();
      const s = page.getByTestId("room-settings");
      await s.waitFor({ state: "visible", timeout: 10_000 });
      return s;
    };

    let settings = await openSettings();
    await settings
      .getByLabel(/Presence-triggered temperature/i)
      .fill(ROOM_SYS_TEMP);
    await settings.getByLabel(/Temperature offset/i).fill(ROOM_TEMP_OFFSET);
    await settings
      .getByLabel(/Deadband override/i)
      .fill(ROOM_DEADBAND_OVERRIDE);

    await settings.getByRole("button", { name: /Save changes/i }).click();
    await settings.waitFor({ state: "detached", timeout: 5_000 });

    // Reopen and verify all persisted values.
    settings = await openSettings();
    const sysTempAfter = await settings
      .getByLabel(/Presence-triggered temperature/i)
      .inputValue();
    const offsetAfter = await settings
      .getByLabel(/Temperature offset/i)
      .inputValue();
    const deadbandOverrideAfter = await settings
      .getByLabel(/Deadband override/i)
      .inputValue();
    expect(parseFloat(sysTempAfter)).toBeCloseTo(parseFloat(ROOM_SYS_TEMP), 1);
    expect(parseFloat(offsetAfter)).toBeCloseTo(
      parseFloat(ROOM_TEMP_OFFSET),
      1,
    );
    expect(parseFloat(deadbandOverrideAfter)).toBeCloseTo(
      parseFloat(ROOM_DEADBAND_OVERRIDE),
      1,
    );
  });

  test("room pre-cool/pre-heat deltas persist exactly as entered (#231)", async ({
    page,
  }) => {
    // @covers: ambient_suppression_min_differential, ambient_suppression_deadband
    // The pre-cool/pre-heat controls only render once an outside temperature
    // sensor is configured. Configure one via the API; skip on the no-HA stack
    // where the sensor entity does not exist (the conversion matrix that
    // actually exercises this runs against real HA).
    //
    // The outside-temp entity is a global setting, and later specs (e.g.
    // thermostats.spec.ts) screenshot the page that renders it — workers:1 runs
    // every spec sequentially against the same stack — so capture the prior
    // value and restore it in `finally` to avoid contaminating those goldens.
    const priorOutside = await (
      await page.request.get("/api/settings/outside-temp-entity")
    ).json();
    const res = await page.request.put("/api/settings/outside-temp-entity", {
      data: { entity_id: "sensor.outdoor_temperature" },
    });
    test.skip(
      !res.ok(),
      "requires an outside temperature sensor (HA-backed stack)",
    );

    try {
      await page.goto("/my-home");
      await page.waitForSelector(".loading", {
        state: "detached",
        timeout: 15_000,
      });
      await page.waitForLoadState("networkidle");

      const openSettings = async () => {
        await page
          .locator(".card")
          .filter({ hasText: "Living Room" })
          .first()
          .getByRole("button", { name: "Room Settings" })
          .click();
        const s = page.getByTestId("room-settings");
        await s.waitFor({ state: "visible", timeout: 10_000 });
        return s;
      };

      let settings = await openSettings();
      // Enable the feature (the checkbox is enabled once the outside sensor loads),
      // then fill the two delta inputs that appear.
      await settings.getByLabel(/pre-cool \/ pre-heat/i).check();
      await settings
        .getByLabel(/Minimum outside difference/i)
        .fill(AMBIENT_MIN_DIFF);
      await settings.getByLabel(/Widened deadband/i).fill(AMBIENT_DEADBAND);

      await settings.getByRole("button", { name: /Save changes/i }).click();
      await settings.waitFor({ state: "detached", timeout: 5_000 });

      // Reopen and verify both deltas survived the °C↔°F round-trip unchanged.
      settings = await openSettings();
      const minDiffAfter = await settings
        .getByLabel(/Minimum outside difference/i)
        .inputValue();
      const deadbandAfter = await settings
        .getByLabel(/Widened deadband/i)
        .inputValue();
      expect(parseFloat(minDiffAfter)).toBeCloseTo(
        parseFloat(AMBIENT_MIN_DIFF),
        1,
      );
      expect(parseFloat(deadbandAfter)).toBeCloseTo(
        parseFloat(AMBIENT_DEADBAND),
        1,
      );
    } finally {
      // Restore the global outside-temp setting for subsequent specs.
      await page.request.put("/api/settings/outside-temp-entity", {
        data: { entity_id: priorOutside?.entity_id ?? null },
      });
    }
  });

  test("thermostat Eco Mode fields persist exactly as entered (#404)", async ({
    page,
  }) => {
    // @covers: eco_cooling_outdoor_threshold, eco_cooling_full_drift_temp, eco_cooling_max_drift, eco_heating_outdoor_threshold, eco_heating_full_drift_temp, eco_heating_max_drift, eco_hysteresis_band
    // Eco Mode is tuned per zone in Smart Control.
    const openEco = async () => {
      await page.goto("/smart-control?section=eco-mode");
      await page.waitForLoadState("networkidle");
      await page.locator(idSel("eco_hysteresis_band")).waitFor();
    };
    // Fill each field via its unique input id, save, reload, and assert the
    // values survived the °C↔°F round-trip unchanged. [id="…"] rather than
    // `#…` because the entity id embeds a dot.
    const idSel = (suffix: string) => `[id="eco-${TC_ID}-${suffix}"]`;
    await openEco();
    const card = page
      .locator(idSel("eco_hysteresis_band"))
      .locator("xpath=ancestor::*[contains(@class,'card')][1]");

    for (const [key, value] of Object.entries(ECO_VALUES)) {
      await page.locator(idSel(key)).fill(value);
    }

    const putResponse = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/thermostats/${TC_ID}`) &&
        r.request().method() === "PUT",
    );
    await card.getByRole("button", { name: "Save" }).click();
    const response = await putResponse;
    const responseText = await response.text();
    expect(
      response.status(),
      `PUT /api/thermostats/${TC_ID} failed: ${responseText}`,
    ).toBeLessThan(400);

    await openEco();

    for (const [key, value] of Object.entries(ECO_VALUES)) {
      const readBack = parseFloat(await page.locator(idSel(key)).inputValue());
      expect(readBack, `eco field ${key}`).toBeCloseTo(parseFloat(value), 1);
    }
  });

  test("room Eco Mode override fields persist exactly as entered (#404)", async ({
    page,
  }) => {
    // @covers: eco_cooling_outdoor_threshold, eco_cooling_full_drift_temp, eco_cooling_max_drift, eco_heating_outdoor_threshold, eco_heating_full_drift_temp, eco_heating_max_drift, eco_hysteresis_band
    await page.goto("/my-home");
    await page.waitForSelector(".loading", {
      state: "detached",
      timeout: 15_000,
    });
    await page.waitForLoadState("networkidle");

    const openSettings = async () => {
      await page
        .locator(".card")
        .filter({ hasText: "Living Room" })
        .first()
        .getByRole("button", { name: "Room Settings" })
        .click();
      const s = page.getByTestId("room-settings");
      await s.waitFor({ state: "visible", timeout: 10_000 });
      return s;
    };

    // The per-room Eco fields are nullable overrides (blank = inherit). Filling
    // a value overrides just that field; they need no outside sensor to edit.
    let settings = await openSettings();
    for (const [key, value] of Object.entries(ECO_VALUES)) {
      await settings.locator(`[id="room-${key}"]`).fill(value);
    }
    await settings.getByRole("button", { name: /Save changes/i }).click();
    await settings.waitFor({ state: "detached", timeout: 5_000 });

    settings = await openSettings();
    for (const [key, value] of Object.entries(ECO_VALUES)) {
      const readBack = parseFloat(
        await settings.locator(`[id="room-${key}"]`).inputValue(),
      );
      expect(readBack, `room eco field ${key}`).toBeCloseTo(
        parseFloat(value),
        1,
      );
    }
  });

  test("schedule target temp and drift band persist exactly as entered (#231)", async ({
    page,
  }) => {
    // @covers: target_temp, deadband_override
    await page.goto("/schedules");
    await page.waitForSelector(".loading", {
      state: "detached",
      timeout: 15_000,
    });
    await page.waitForLoadState("networkidle");

    // Room cards on /schedules are collapsed by default — click the room's
    // title row to expand it, then the "+ Add schedule block" button appears.
    const livingRoomCard = page
      .locator(".card")
      .filter({ hasText: "Living Room" })
      .first();
    await livingRoomCard.getByText("Living Room").click();

    await livingRoomCard.getByText("+ Add schedule block").click();

    const modal = page.locator(".modal");
    await modal.waitFor({ state: "visible", timeout: 10_000 });

    // global-setup seeds two Mon-Fri blocks on Living Room: 08:00-17:00 and
    // 20:00-22:00 (#456). Pick the 18:00-20:00 gap between them so the overlap
    // check (a strict [start,end)) doesn't reject the save — an overlap would
    // leave the modal open and time us out.
    await modal.getByLabel(/Start time/i).fill("18:00");
    await modal.getByLabel(/End time/i).fill("20:00");
    await modal.getByLabel(/Target temperature/i).fill(SCHEDULE_TARGET);

    // The drift band exercises a DIFFERENT conversion than the target above:
    // _delta_to_f (x9/5) rather than _to_f (x9/5 + 32). A regression routing
    // it through the absolute helper would store 33.8°F for "1°C" and this
    // assertion would catch it.
    await modal.getByRole("radio", { name: /override deadband/i }).click();
    await modal.getByLabel(/^Deadband/i).fill(SCHEDULE_DRIFT);

    await modal.getByRole("button", { name: /^Save$/ }).click();
    await modal.waitFor({ state: "detached", timeout: 5_000 });

    // Reload and verify the new block is present with the value the user
    // typed. The schedules table renders the target via fmtTemp(°F) which
    // re-derives the display unit from storage; if the backend stored the
    // wrong value the rendered number would be off.
    await page.reload();
    await page.waitForSelector(".loading", {
      state: "detached",
      timeout: 15_000,
    });
    await page.waitForLoadState("networkidle");

    const livingRoomCardReloaded = page
      .locator(".card")
      .filter({ hasText: "Living Room" })
      .first();
    await livingRoomCardReloaded.getByText("Living Room").click();

    const newBlockRow = livingRoomCardReloaded
      .locator("tr")
      .filter({ hasText: "18:00" });
    await expect(newBlockRow).toBeVisible();
    const text = await newBlockRow.innerText();
    const match = text.match(/(\d+(?:\.\d+)?)\s*°[CF]/);
    expect(match, `target temp not found in row: ${text}`).not.toBeNull();
    expect(parseFloat(match![1])).toBeCloseTo(parseFloat(SCHEDULE_TARGET), 1);

    // The row badges a block that carries a band, rendered via toDisplayDelta
    // — so it re-derives the display value from °F storage just like the
    // target does.
    // Case-insensitive: the badge class uppercases its text via CSS, so the
    // rendered innerText is "±1.8°F DRIFT".
    const drift = text.match(/±\s*(\d+(?:\.\d+)?)\s*°[CF]\s*drift/i);
    expect(drift, `drift badge not found in row: ${text}`).not.toBeNull();
    expect(parseFloat(drift![1])).toBeCloseTo(parseFloat(SCHEDULE_DRIFT), 1);

    // And it survives reopening the editor: custom mode still selected, same
    // number in the input — the read path the user actually edits through.
    await newBlockRow.getByRole("button", { name: "Edit" }).click();
    const reopened = page.locator(".modal");
    await reopened.waitFor({ state: "visible", timeout: 10_000 });
    await expect(
      reopened.getByRole("radio", { name: /override deadband/i }),
    ).toBeChecked();
    const band = await reopened.getByLabel(/^Deadband/i).inputValue();
    expect(parseFloat(band)).toBeCloseTo(parseFloat(SCHEDULE_DRIFT), 1);
  });

  test("schedule and occupancy Cool To persist exactly as entered", async ({
    page,
  }) => {
    // @covers: cool_to, presence_cool_to
    // A Cool To turns a target into a band. It is an absolute temperature
    // like the target beside it, sent as typed and converted once.
    const HEAT = isCelsius ? "20" : "68";
    const COOL = isCelsius ? "24" : "76";

    await page.goto("/schedules");
    await page.waitForSelector(".loading", {
      state: "detached",
      timeout: 15_000,
    });
    await page.waitForLoadState("networkidle");
    const card = () =>
      page.locator(".card").filter({ hasText: "Living Room" }).first();
    await card().getByText("Living Room").click();
    await card().getByText("+ Add schedule block").click();
    const modal = page.locator(".modal");
    await modal.waitFor({ state: "visible", timeout: 10_000 });
    // 05:00-06:00 is clear of the seeded blocks and of the block the test above adds.
    await modal.getByLabel(/Start time/i).fill("05:00");
    await modal.getByLabel(/End time/i).fill("06:00");
    await modal.getByLabel(/Target temperature/i).fill(HEAT);
    await modal.getByLabel(/Cool To/i).fill(COOL);
    await modal.getByRole("button", { name: /^Save$/ }).click();
    await modal.waitFor({ state: "detached", timeout: 5_000 });

    await page.reload();
    await page.waitForSelector(".loading", {
      state: "detached",
      timeout: 15_000,
    });
    await page.waitForLoadState("networkidle");
    await card().getByText("Living Room").click();
    const row = card().locator("tr").filter({ hasText: "05:00" });
    await expect(row).toBeVisible();
    const text = await row.innerText();
    const band = text.match(
      /(\d+(?:\.\d+)?)\s*°[CF]\s+to\s+(\d+(?:\.\d+)?)\s*°[CF]/,
    );
    expect(band, `band not found in row: ${text}`).not.toBeNull();
    expect(parseFloat(band![1])).toBeCloseTo(parseFloat(HEAT), 1);
    expect(parseFloat(band![2])).toBeCloseTo(parseFloat(COOL), 1);
    // Remove the block so nothing else sees a band on Living Room.
    // The row's button is "Del"; the dialog it opens has the "Delete" that does it.
    await row.getByRole("button", { name: "Del", exact: true }).click();
    const dialog = page.getByTestId("confirm-dialog");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await dialog.waitFor({ state: "detached", timeout: 5_000 });
    await expect(row).toHaveCount(0);

    // The occupancy target's Cool To, in the room's settings under My Home.
    await page.goto("/my-home");
    await page.waitForSelector(".loading", {
      state: "detached",
      timeout: 15_000,
    });
    await page.waitForLoadState("networkidle");
    const openSettings = async () => {
      await page
        .locator(".card")
        .filter({ hasText: "Living Room" })
        .first()
        .getByRole("button", { name: "Room Settings" })
        .click();
      const s = page.getByTestId("room-settings");
      await s.waitFor({ state: "visible", timeout: 10_000 });
      return s;
    };
    let settings = await openSettings();
    await settings.getByLabel(/Presence-triggered temperature/i).fill(HEAT);
    await settings.getByLabel(/Cool To/i).fill(COOL);
    await settings.getByRole("button", { name: /Save changes/i }).click();
    await settings.waitFor({ state: "detached", timeout: 5_000 });
    settings = await openSettings();
    const coolAfter = await settings.getByLabel(/Cool To/i).inputValue();
    expect(parseFloat(coolAfter)).toBeCloseTo(parseFloat(COOL), 1);
    // Back to a single target, as the other specs expect.
    await settings.getByLabel(/Cool To/i).fill("");
    await settings.getByRole("button", { name: /Save changes/i }).click();
    await settings.waitFor({ state: "detached", timeout: 5_000 });
  });

  test("temporary hold target persists exactly as entered (#576)", async ({
    page,
  }) => {
    // @covers: target_temp
    // The hold write path (HoldModal → POST /api/rooms/{id}/override) is a
    // separate frontend form from the schedule modal, so it needs its own
    // round-trip: the modal submits the raw display value and the backend's
    // _to_f converts once — a re-introduced frontend conversion would render
    // the read-back target off by the °C↔°F factor.
    let heldRoomId: string | null = null;
    try {
      // Holds are a manual control, so they live on the Dashboard.
      await page.goto("/");
      await page.waitForSelector(".loading", {
        state: "detached",
        timeout: 15_000,
      });
      await page.waitForLoadState("networkidle");

      // Open the hold modal pre-scoped to Living Room (the room this spec
      // owns) from its row. `exact: true` — the row offers "Cancel Hold for …"
      // instead when a hold is already live, which would mean leaked state
      // from an earlier run.
      await page
        .locator(".dash-room")
        .filter({ hasText: "Living Room" })
        .first()
        .getByRole("button", { name: "Hold for Living Room", exact: true })
        .click();
      const modal = page.getByTestId("hold-modal");
      await modal.waitFor({ state: "visible", timeout: 10_000 });

      await modal.locator("#hold-target-temp").fill(HOLD_TARGET);
      await modal.locator("#hold-duration").selectOption("4");

      // Capture the POST response — when this assertion fails the body text
      // surfaces the actual backend error (range/validation/etc) instead of
      // an opaque "modal never closed" timeout.
      const postResponse = page.waitForResponse(
        (r) => r.url().includes("/override") && r.request().method() === "POST",
      );
      await page.getByTestId("hold-modal-save").click();
      const response = await postResponse;
      const responseText = await response.text();
      expect(
        response.status(),
        `POST /api/rooms/{id}/override failed: ${responseText}`,
      ).toBeLessThan(400);
      // Remember the room for cleanup — the POST URL carries its id.
      heldRoomId =
        response.url().match(/\/api\/rooms\/([^/]+)\/override/)?.[1] ?? null;
      await modal.waitFor({ state: "detached", timeout: 5_000 });

      // Reload and read back through the Dashboard's hold strip. The target
      // is rendered via fmtTemp(°F), re-deriving the display unit from
      // storage — if the backend stored the wrong value the number would be
      // off.
      await page.reload();
      await page.waitForSelector(".loading", {
        state: "detached",
        timeout: 15_000,
      });
      await page.waitForLoadState("networkidle");

      const strip = page.getByTestId(`dashboard-hold-${heldRoomId}`);
      await expect(strip).toContainText("Living Room");
      const stripText = await strip.innerText();
      const match = stripText.match(/held at\s*(\d+(?:\.\d+)?)\s*°[CF]/);
      expect(
        match,
        `hold target not found in the hold strip: ${stripText}`,
      ).not.toBeNull();
      expect(parseFloat(match![1])).toBeCloseTo(parseFloat(HOLD_TARGET), 1);
    } finally {
      // Clear the hold so later specs see Living Room back on its schedule.
      // DELETE is idempotent for a missing hold; null means the POST never
      // fired, so there is nothing to clean up.
      if (heldRoomId) {
        await page.request.delete(`/api/rooms/${heldRoomId}/override`);
      }
    }
  });

  test("zone heat pump protection persists exactly as entered", async ({
    page,
  }) => {
    // @covers: hp_max_step_f, hp_recovery_f_per_hr, hp_compressor_lockout_f
    // Step and recovery rate are deltas (1°C ≡ 1.8°F, 2°C ≡ 3.6°F); the
    // compressor lockout is absolute (-5°C ≡ 23°F). All round-trip cleanly
    // through the backend's 2dp °F storage.
    const STEP = isCelsius ? "1" : "1.8";
    const RATE = isCelsius ? "2" : "3.6";
    const LOCKOUT = isCelsius ? "-5" : "23";
    const editor = () =>
      page.getByRole("region", { name: /Edit Downstairs Thermostat/ });
    const open = async () => {
      await page.goto("/my-home");
      await page.waitForLoadState("networkidle");
      await page
        .locator(".zone-row")
        .filter({ hasText: TC_ID })
        .getByRole("button", { name: "Edit Zone" })
        .click();
      await editor().waitFor({ state: "visible", timeout: 10_000 });
      return editor();
    };
    try {
      let zone = await open();
      await zone.getByRole("radio", { name: "Heat Pump" }).click();
      await zone.getByLabel("Max Setpoint Step").fill(STEP);
      await zone.getByLabel("Max Recovery Rate").fill(RATE);
      await zone.getByLabel("Compressor Lockout Below").fill(LOCKOUT);
      const saved = page.waitForResponse(
        (r) =>
          r.url().includes(`/api/zones/${TC_ID}`) &&
          r.request().method() === "PUT",
      );
      await zone.getByRole("button", { name: "Save Zone" }).click();
      expect((await saved).ok()).toBeTruthy();

      zone = await open();
      for (const [label, value] of [
        ["Max Setpoint Step", STEP],
        ["Max Recovery Rate", RATE],
        ["Compressor Lockout Below", LOCKOUT],
      ] as const) {
        const after = await zone.getByLabel(label).inputValue();
        expect(parseFloat(after)).toBeCloseTo(parseFloat(value), 1);
      }
    } finally {
      // Leave the zone conventional for the specs that screenshot it.
      await page.request.put(`/api/zones/${TC_ID}`, {
        data: {
          system_type: "conventional",
          hp_max_step_f: isCelsius ? 0.5556 : 1,
          hp_recovery_f_per_hr: isCelsius ? 1.1111 : 2,
          hp_compressor_lockout_f: null,
        },
      });
    }
  });

  test("a zone's targets persist exactly as entered", async ({ page }) => {
    // @covers: house_heat_to, house_cool_to
    const heatLabel = /^Heating Target for Downstairs Thermostat/;
    const coolLabel = /^Cooling Target for Downstairs Thermostat/;
    try {
      await page.goto("/");
      await page.waitForSelector(".loading", {
        state: "detached",
        timeout: 15_000,
      });
      await page.getByLabel(heatLabel).fill(HOUSE_HEAT_TO);
      await page.getByLabel(coolLabel).fill(HOUSE_COOL_TO);
      await page
        .getByRole("button", { name: "Save targets for Downstairs Thermostat" })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Clear targets for Downstairs Thermostat",
        }),
      ).toBeVisible();

      await page.reload();
      await page.waitForSelector(".loading", {
        state: "detached",
        timeout: 15_000,
      });
      expect(
        parseFloat(await page.getByLabel(heatLabel).inputValue()),
      ).toBeCloseTo(parseFloat(HOUSE_HEAT_TO), 1);
      expect(
        parseFloat(await page.getByLabel(coolLabel).inputValue()),
      ).toBeCloseTo(parseFloat(HOUSE_COOL_TO), 1);
    } finally {
      // Leave no targets behind: with them set, every room in the zone becomes active.
      await page.request.put(`/api/house/targets/zone/${TC_ID}`, {
        data: { house_heat_to: null, house_cool_to: null },
      });
    }
  });

  test("a building's switching threshold persists exactly as entered", async ({
    page,
  }) => {
    // @covers: switch_threshold
    // A difference, not a temperature: 2.5°C ≡ 4.5°F, with no 32° offset.
    const THRESHOLD = isCelsius ? "2.5" : "4.5";
    const made = await page.request.post("/api/buildings", {
      data: { name: "Threshold Test House" },
    });
    const building = (await made.json()).id as string;
    try {
      await page.goto("/smart-control?section=auto-mode");
      const field = page.getByLabel(
        /^Switching threshold for Threshold Test House/,
      );
      await field.waitFor({ state: "visible", timeout: 15_000 });
      const saved = page.waitForResponse(
        (r) =>
          r.url().includes(`/api/building-modes/${building}`) &&
          r.request().method() === "PUT",
      );
      await field.fill(THRESHOLD);
      await page
        .getByRole("button", {
          name: "Save switching threshold for Threshold Test House",
        })
        .click();
      await saved;

      await page.reload();
      const after = page.getByLabel(
        /^Switching threshold for Threshold Test House/,
      );
      await after.waitFor({ state: "visible", timeout: 15_000 });
      expect(parseFloat(await after.inputValue())).toBeCloseTo(
        parseFloat(THRESHOLD),
        2,
      );
    } finally {
      await page.request.delete(`/api/buildings/${building}`);
    }
  });

  test("zone balance gap limit persists exactly as chosen", async ({
    page,
  }) => {
    // @covers: zone_gap
    // A difference, not a temperature: 2.5°C ≡ 4.5°F, with no 32° offset.
    const GAP = isCelsius ? "2.5" : "5";
    const made = await page.request.post("/api/buildings", {
      data: { name: "Gap Test House" },
    });
    const building = (await made.json()).id as string;
    try {
      await page.goto("/smart-control?section=zone-balance");
      const gap = page.getByLabel("Gap limit for Gap Test House");
      await gap.waitFor({ state: "visible", timeout: 15_000 });
      const saved = page.waitForResponse(
        (r) =>
          r.url().includes(`/api/zone-balance/${building}`) &&
          r.request().method() === "PUT",
      );
      await gap.selectOption(GAP);
      await saved;

      await page.reload();
      await expect(page.getByLabel("Gap limit for Gap Test House")).toHaveValue(
        GAP,
      );
    } finally {
      await page.request.delete(`/api/buildings/${building}`);
    }
  });

  test("peak hours banking depth persists exactly as chosen", async ({
    page,
  }) => {
    // @covers: peak_depth
    // A difference, not a temperature: 1.5°C ≡ 2.7°F, with no 32° offset.
    const DEPTH = isCelsius ? "1.5" : "3";
    try {
      await page.goto("/smart-control?section=peak-hours");
      const depth = page.getByLabel("How far to bank");
      await depth.waitFor({ state: "visible", timeout: 15_000 });
      const saved = page.waitForResponse(
        (r) =>
          r.url().includes("/api/peak-hours") && r.request().method() === "PUT",
      );
      await depth.selectOption(DEPTH);
      await saved;

      await page.reload();
      await expect(page.getByLabel("How far to bank")).toHaveValue(DEPTH);
    } finally {
      await page.request.put("/api/peak-hours", {
        data: { peak_depth: isCelsius ? 1.1 : 2 },
      });
    }
  });
});
