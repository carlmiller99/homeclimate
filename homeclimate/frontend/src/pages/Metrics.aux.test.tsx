import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as zonesApi from "../zonesApi";
import { HP_DEFAULTS } from "../zoneFixtures";
import { BackupHeatTile } from "./Metrics";

vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getZones: vi.fn(),
  getAuxSummary: vi.fn(),
}));

const zone = (over: Partial<zonesApi.ZoneProfile>): zonesApi.ZoneProfile => ({
  thermostat_entity_id: "climate.wing",
  name: "South Wing",
  building_id: null,
  sort_order: 0,
  system_type: "heat_pump",
  compressor_stages: 2,
  backup_heat: "electric",
  equipment_running_entity: null,
  heat_kit_confirmed: false,
  ...HP_DEFAULTS,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(zonesApi.getAuxSummary).mockResolvedValue({ episodes: 2, minutes: 34.5 });
});

describe("BackupHeatTile", () => {
  it("shows backup heat minutes for a heat pump zone", async () => {
    vi.mocked(zonesApi.getZones).mockResolvedValue([zone({})]);
    render(<BackupHeatTile entityId="climate.wing" range={{ start: "2026-01-01" }} />);
    expect(await screen.findByText("34.5 min")).toBeInTheDocument();
    expect(screen.getByText("2 episodes")).toBeInTheDocument();
    expect(zonesApi.getAuxSummary).toHaveBeenCalledWith("climate.wing", { start: "2026-01-01" });
  });

  it("shows a conventional zone with an equipment source, in the singular", async () => {
    vi.mocked(zonesApi.getAuxSummary).mockResolvedValue({ episodes: 1, minutes: 3 });
    vi.mocked(zonesApi.getZones).mockResolvedValue([
      zone({ system_type: "conventional", equipment_running_entity: "sensor.strips" }),
    ]);
    render(<BackupHeatTile entityId="climate.wing" range={{}} />);
    expect(await screen.findByText("1 episode")).toBeInTheDocument();
  });

  it("stays hidden for other zones, unknown zones and failures", async () => {
    vi.mocked(zonesApi.getZones).mockResolvedValue([zone({ system_type: "conventional" })]);
    const { container, unmount } = render(<BackupHeatTile entityId="climate.wing" range={{}} />);
    await waitFor(() => expect(zonesApi.getAuxSummary).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    vi.mocked(zonesApi.getZones).mockResolvedValue([]);
    const second = render(<BackupHeatTile entityId="climate.none" range={{}} />);
    await waitFor(() => expect(zonesApi.getZones).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
    second.unmount();
    vi.mocked(zonesApi.getZones).mockRejectedValue(new Error("down"));
    const third = render(<BackupHeatTile entityId="climate.wing" range={{}} />);
    await waitFor(() => expect(zonesApi.getZones).toHaveBeenCalledTimes(3));
    expect(third.container).toBeEmptyDOMElement();
    // A late answer after unmount is ignored.
    let resolve: (z: zonesApi.ZoneProfile[]) => void = () => {};
    vi.mocked(zonesApi.getZones).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const fourth = render(<BackupHeatTile entityId="climate.wing" range={{}} />);
    fourth.unmount();
    resolve([zone({})]);
    await Promise.resolve();
  });
});

describe("getAuxSummary", () => {
  it("builds the range query", async () => {
    const real = await vi.importActual<typeof import("../zonesApi")>("../zonesApi");
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
    await real.getAuxSummary("climate.a", { start: "2026-01-01", end: "2026-01-07" });
    await real.getAuxSummary("climate.a");
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      "/api/metrics/thermostats/climate.a/aux?start=2026-01-01&end=2026-01-07",
      "/api/metrics/thermostats/climate.a/aux",
    ]);
    vi.unstubAllGlobals();
  });
});
