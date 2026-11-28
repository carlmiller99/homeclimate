import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeBalance,
  getZoneBalance,
  setZoneBalance,
  type BalanceBuilding,
  type BalanceZone,
} from "./zoneBalanceApi";

afterEach(() => vi.unstubAllGlobals());

describe("zoneBalanceApi requests", () => {
  it("calls the Zone Balance endpoints, sending the gap as given", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getZoneBalance();
    await setZoneBalance("b 1", { level: "on", zone_gap: 2.5 });
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", i?.body])).toEqual([
      ["/api/zone-balance", "GET", undefined],
      ["/api/zone-balance/b%201", "PUT", JSON.stringify({ level: "on", zone_gap: 2.5 })],
    ]);
  });
});

describe("describeBalance", () => {
  const zone = (over: Partial<BalanceZone> = {}): BalanceZone => ({
    thermostat_entity_id: "climate.a",
    name: "North Wing",
    temp: 70,
    occupied: true,
    target: null,
    toward: null,
    obeyed: true,
    answering: false,
    ...over,
  });
  const B: BalanceBuilding = {
    building_id: "b1",
    name: "Main House",
    level: "on",
    zone_gap: 4,
    direction: "heating",
    spread: 2,
    zones: [zone(), zone({ thermostat_entity_id: "climate.b", name: "South Wing", temp: 72 })],
  };
  const t = (f: number) => `${f}°F`;
  const say = (b: Partial<BalanceBuilding>) => describeBalance({ ...B, ...b }, t, t);

  it("says what the zones are doing about the gap", () => {
    expect(say({ zones: [zone()] })).toBe("Needs two zones in the building.");
    expect(say({ spread: null })).toBe("Waiting for a temperature from two zones.");
    expect(say({ zones: [zone({ target: 68, answering: true }), B.zones[1]] })).toBe(
      "Zones are 2°F apart. Now heating North Wing to 68°F."
    );
    expect(
      say({ direction: "cooling", zones: [zone({ target: 74, answering: true }), B.zones[1]] })
    ).toBe("Zones are 2°F apart. Now cooling North Wing to 74°F.");
    expect(say({ zones: [zone({ target: 68 }), B.zones[1]] })).toMatch(
      /^Zones are 2°F apart\. Asking for North Wing to 68°F, but no room there can answer/
    );
    expect(say({ level: "off" })).toBe("Zones are 2°F apart.");
    expect(say({ direction: null })).toBe(
      "Zones are 2°F apart. Nothing is heating or cooling here, so nothing is balanced."
    );
    expect(say({ zones: B.zones.map((z) => ({ ...z, occupied: false })) })).toBe(
      "Zones are 2°F apart. No zone is in use, so nothing is balanced."
    );
    expect(say({})).toBe("Zones are 2°F apart. Inside the limit.");
  });
});
