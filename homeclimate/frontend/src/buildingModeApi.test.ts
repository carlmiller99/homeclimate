import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeBuilding,
  getBuildingModes,
  setBuildingMode,
  type BuildingMode,
} from "./buildingModeApi";

afterEach(() => vi.unstubAllGlobals());

const B: BuildingMode = {
  building_id: "b1",
  name: "Main House",
  mode: "auto",
  auto_level: "on",
  side: "heating",
  obey: true,
  note: "",
  waiting: [],
};

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
    expect(describeBuilding({ ...B, mode: "heat_only" })).toMatch(/^Heating only/);
    expect(describeBuilding({ ...B, mode: "cool_only" })).toMatch(/^Cooling only/);
    expect(describeBuilding({ ...B, auto_level: "off" })).toBe(
      "Each zone chooses heating or cooling for itself."
    );
    expect(describeBuilding({ ...B, side: null })).toBe(
      "Not on a side yet; the first cycle decides."
    );
    expect(describeBuilding(B)).toBe("Heating for every zone.");
    expect(describeBuilding({ ...B, side: "cooling", note: "Waiting for cooling to finish" })).toBe(
      "Cooling for every zone. Waiting for cooling to finish."
    );
    expect(describeBuilding({ ...B, auto_level: "watch" })).toBe(
      "Watching only: would be on heating."
    );
  });
});
