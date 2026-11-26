import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFan, describeTest, getFan, testFan, type FanZone } from "./fanApi";

afterEach(() => vi.unstubAllGlobals());

const Z: FanZone = {
  thermostat_entity_id: "climate.a",
  name: "Upstairs",
  level: "on",
  air_intake: "unsure",
  supported: true,
  running: false,
  testing: false,
  note: "",
  minutes_last_hour: 0,
  test: null,
};
const delta = (f: number) => `${f}°F`;

describe("fanApi", () => {
  it("calls the fan endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ zones: [], test_minutes: 10 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getFan();
    await testFan("climate.south wing");
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET"])).toEqual([
      ["/api/fan", "GET"],
      ["/api/fan/climate.south%20wing/test", "POST"],
    ]);
  });

  it("says what a zone's fan is doing", () => {
    expect(describeFan({ ...Z, level: "off", note: "ignored" })).toBe(
      "Off. The fan is left to the thermostat."
    );
    expect(describeFan(Z)).toBe("On: nothing to mix right now.");
    expect(describeFan({ ...Z, level: "watch" })).toBe("Watching only: nothing to mix right now.");
    expect(describeFan({ ...Z, note: "Waiting 4 min after cooling" })).toBe(
      "Waiting 4 min after cooling."
    );
    expect(describeFan({ ...Z, level: "off", testing: true })).toBe(
      "Testing for an outside air intake."
    );
  });

  it("puts a test's result in a sentence and calls it a hint", () => {
    expect(describeTest(null, delta)).toBe("Not tested yet.");
    expect(describeTest({ at: "x", interrupted: true }, delta)).toMatch(/cut short/);
    expect(describeTest({ at: "x", interrupted: false }, delta)).toMatch(/cut short/);
    expect(describeTest({ at: "x", interrupted: false, difference: 30 }, delta)).toMatch(
      /cut short/
    );
    const possible = describeTest(
      { at: "x", interrupted: false, difference: 30, moved: 0.7, hint: "possible" },
      delta
    );
    expect(possible).toMatch(/^With inside and outside 30°F apart, the rooms moved 0.7°F toward/);
    expect(possible).toMatch(/could be an outside air intake, but mixing and ducts/);
    const none = describeTest(
      { at: "x", interrupted: false, difference: 30, moved: -0.2, hint: "none" },
      delta
    );
    expect(none).toMatch(/moved 0.2°F away from the outside temperature\. No sign/);
  });
});
