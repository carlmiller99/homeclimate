import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeBuilding,
  describeZoneMode,
  getBuildingModes,
  setBuildingMode,
  zoneModeWord,
  zoneWaitText,
  type BuildingMode,
  type ZoneModeState,
} from "./buildingModeApi";

afterEach(() => vi.unstubAllGlobals());

const zone = (over: Partial<ZoneModeState> = {}): ZoneModeState => ({
  thermostat_entity_id: "climate.north",
  name: "North Wing",
  mode: "follow",
  effective_mode: "auto",
  side: "heating",
  note: "",
  next_switch_at: null,
  waiting: null,
  held_for: null,
  in_use: true,
  ...over,
});

const B: BuildingMode = {
  building_id: "b1",
  name: "Main House",
  mode: "auto",
  opposite_allowed: false,
  switching: "often",
  switch_threshold: 3,
  zones: [zone()],
};

const SOUTH = zone({
  thermostat_entity_id: "climate.south",
  name: "South Wing",
  mode: "cool",
  effective_mode: "cool",
  side: null,
  held_for: "cooling",
});

describe("buildingModeApi", () => {
  it("calls the building mode endpoints and unwraps the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ buildings: [B] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getBuildingModes()).toEqual([B]);
    expect(await setBuildingMode("b 1", { mode: "off" })).toEqual([B]);
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", i?.body])).toEqual([
      ["/api/building-modes", "GET", undefined],
      ["/api/building-modes/b%201", "PUT", JSON.stringify({ mode: "off" })],
    ]);
  });

  it("describes what a building is doing", () => {
    expect(describeBuilding({ ...B, mode: "off" })).toMatch(/^Off\. No room here asks/);
    expect(describeBuilding(B)).toBe("Auto.");
    expect(describeBuilding({ ...B, mode: "heat_only" })).toBe("Heat Only.");
    expect(describeBuilding({ ...B, mode: "cool_only", zones: [] })).toBe("Cool Only.");
    expect(describeBuilding({ ...B, zones: [zone(), SOUTH] })).toBe(
      "Auto. South Wing waits while North Wing heats."
    );
    // Nobody running the other way to name.
    expect(describeBuilding({ ...B, zones: [SOUTH] })).toBe("Auto. South Wing waits.");
    expect(
      describeBuilding({
        ...B,
        zones: [zone({ side: "cooling", name: "Den" }), { ...SOUTH, held_for: "heating" }],
      })
    ).toBe("Auto. South Wing waits while Den cools.");
    expect(
      describeBuilding({ ...B, zones: [zone({ side: "fan" }), { ...SOUTH, held_for: "heating" }] })
    ).toBe("Auto. South Wing waits while North Wing runs.");
  });

  it("says a zone's mode in a word or two", () => {
    expect(describeZoneMode(zone(), "Main House")).toBe("Follows Main House");
    expect(describeZoneMode(zone({ mode: "auto" }), "Main House")).toBe("Auto");
    expect(describeZoneMode(SOUTH, "Main House")).toBe("Set to Cool");
    expect(zoneModeWord("follow", "Main House")).toBe("Follows Main House");
    expect(zoneModeWord("follow", null)).toBe("Auto");
    expect(zoneModeWord("heat", null)).toBe("Heat");
  });

  it("says why a zone is waiting, or nothing", () => {
    const b = { ...B, zones: [zone(), SOUTH] };
    expect(zoneWaitText(SOUTH, b)).toBe(
      "Set to Cool. Waits while North Wing heats, because zones in Main House may not run opposite each other."
    );
    expect(zoneWaitText({ ...SOUTH, mode: "follow" }, { ...B, zones: [SOUTH] })).toBe(
      "Waits, because zones in Main House may not run opposite each other."
    );
    expect(
      zoneWaitText(
        { ...SOUTH, held_for: "heating" },
        { ...B, zones: [zone({ side: "fan" }), SOUTH] }
      )
    ).toMatch(/^Set to Cool\. Waits while North Wing runs,/);
    expect(zoneWaitText(zone({ note: "Wants cooling; 3 hours until it may switch" }), b)).toBe(
      "Wants cooling; 3 hours until it may switch."
    );
    expect(zoneWaitText(zone(), b)).toBeNull();
  });
});
