import { HP_DEFAULTS } from "./zoneFixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBuilding,
  deleteBuilding,
  equipmentSummary,
  getBuildings,
  getImportPreview,
  getZones,
  runImport,
  groupByBuilding,
  updateBuilding,
  updateZone,
  type ZoneProfile,
} from "./zonesApi";

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) });

afterEach(() => vi.unstubAllGlobals());

describe("zonesApi requests", () => {
  it("calls the buildings and zones endpoints", async () => {
    const fetchMock = ok([]);
    vi.stubGlobal("fetch", fetchMock);
    await getBuildings();
    await createBuilding("Main");
    await updateBuilding("b1", { name: "Home" });
    await deleteBuilding("b1");
    await getZones();
    await updateZone("climate.a", { system_type: "heat_pump" });
    await getImportPreview();
    const body = { zones: [], rooms: [], skipped_areas: [] };
    await runImport(body);
    const calls = fetchMock.mock.calls.map(([url, init]) => [
      url,
      init?.method ?? "GET",
      init?.body,
    ]);
    expect(calls).toEqual([
      ["/api/buildings", "GET", undefined],
      ["/api/buildings", "POST", JSON.stringify({ name: "Main" })],
      ["/api/buildings/b1", "PUT", JSON.stringify({ name: "Home" })],
      ["/api/buildings/b1", "DELETE", undefined],
      ["/api/zones", "GET", undefined],
      ["/api/zones/climate.a", "PUT", JSON.stringify({ system_type: "heat_pump" })],
      ["/api/ha/import-preview", "GET", undefined],
      ["/api/ha/import", "POST", JSON.stringify(body)],
    ]);
  });
});

const base: ZoneProfile = {
  thermostat_entity_id: "climate.a",
  name: "A",
  building_id: null,
  sort_order: 0,
  system_type: "conventional",
  compressor_stages: 1,
  backup_heat: "gas",
  equipment_running_entity: null,
  heat_kit_confirmed: false,
  ...HP_DEFAULTS,
};

describe("equipmentSummary", () => {
  it("names type, stages and backup heat", () => {
    expect(equipmentSummary(base)).toBe("Conventional, Gas (Dual Fuel)");
    expect(
      equipmentSummary({
        ...base,
        system_type: "heat_pump",
        compressor_stages: 2,
        backup_heat: "none",
      })
    ).toBe("Heat Pump, 2 Stage, No Auxiliary Heat");
  });
});

describe("groupByBuilding", () => {
  it("keeps building order and collects unknown ids as unassigned", () => {
    const groups = groupByBuilding(
      [
        { id: "b1", name: "One", sort_order: 0 },
        { id: "b2", name: "Two", sort_order: 1 },
      ],
      [
        { id: 1, b: "b2" },
        { id: 2, b: null },
        { id: 3, b: "gone" },
      ],
      (i) => i.b
    );
    expect(groups.map((g) => [g.building?.name ?? null, g.items.map((i) => i.id)])).toEqual([
      ["One", []],
      ["Two", [1]],
      [null, [2, 3]],
    ]);
  });

  it("omits the unassigned group when every item is placed", () => {
    const groups = groupByBuilding(
      [{ id: "b1", name: "One", sort_order: 0 }],
      [{ b: "b1" }],
      (i) => i.b
    );
    expect(groups).toHaveLength(1);
  });
});
