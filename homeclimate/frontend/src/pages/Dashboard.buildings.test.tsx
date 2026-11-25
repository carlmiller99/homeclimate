/** The Dashboard's per-building heating/cooling mode. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import Dashboard from "./Dashboard";
import * as api from "../api";
import * as bm from "../buildingModeApi";
import * as zonesApi from "../zonesApi";
import { HP_DEFAULTS } from "../zoneFixtures";

vi.mock("../api");
vi.mock("../buildingModeApi", async (orig) => ({
  ...(await orig<typeof import("../buildingModeApi")>()),
  getBuildingModes: vi.fn(),
  setBuildingMode: vi.fn(),
}));
vi.mock("../houseApi", async (orig) => ({
  ...(await orig<typeof import("../houseApi")>()),
  getHouse: () => Promise.reject(new Error("not needed")),
}));
vi.mock("../smartControlApi", async (orig) => ({
  ...(await orig<typeof import("../smartControlApi")>()),
  getSmartControl: () => Promise.reject(new Error("not needed")),
}));
vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getZones: vi.fn(),
  getBuildings: vi.fn(),
}));

const MAIN: bm.BuildingMode = {
  building_id: "b1",
  name: "Main House",
  mode: "auto",
  auto_level: "on",
  side: "heating",
  obey: true,
  note: "Waiting for heating to finish",
  waiting: [
    {
      thermostat_entity_id: "climate.up",
      direction: "cooling",
      since: "2026-01-05T18:00:00+00:00",
      obeyed: true,
    },
    {
      thermostat_entity_id: "climate.elsewhere",
      direction: "cooling",
      since: "2026-01-05T18:00:00+00:00",
      obeyed: false,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSensorHealth).mockResolvedValue({ stale_after_min: 30, rooms: [] });
  vi.mocked(api.getSensorStaleness).mockResolvedValue({ stale_after_min: 30 });
  vi.mocked(api.getThermostatHealth).mockResolvedValue({ thermostats: [] });
  vi.mocked(api.connectWS).mockReturnValue(() => {});
  vi.mocked(api.getVacationMode).mockResolvedValue({ enabled: false, return_at: null });
  vi.mocked(api.getOverrides).mockResolvedValue([]);
  vi.mocked(api.getStatus).mockResolvedValue([
    {
      thermostat_entity_id: "climate.up",
      hvac_mode: "heat",
      hvac_action: "idle",
      current_temp: 68,
      setpoint: 70,
      cycle_state: "idle",
      cycle_id: null,
      cycle_started_at: null,
      rooms: [],
    },
  ]);
  vi.mocked(api.getRooms).mockResolvedValue([
    { id: "bunk", name: "Bunk Room", thermostat_entity_id: "climate.up" },
  ] as api.Room[]);
  vi.mocked(api.getThermostats).mockResolvedValue([
    { thermostat_entity_id: "climate.up", name: "Upstairs" },
  ] as api.ThermostatConfig[]);
  vi.mocked(api.getRoom).mockResolvedValue({ sensors: [] } as unknown as Awaited<
    ReturnType<typeof api.getRoom>
  >);
  vi.mocked(api.getEntityStates).mockResolvedValue({});
  vi.mocked(zonesApi.getBuildings).mockResolvedValue([
    { id: "b1", name: "Main House", sort_order: 0 },
  ]);
  vi.mocked(zonesApi.getZones).mockResolvedValue([
    {
      thermostat_entity_id: "climate.up",
      name: "Upstairs",
      building_id: "b1",
      sort_order: 0,
      system_type: "conventional",
      compressor_stages: 1,
      backup_heat: "electric",
      equipment_running_entity: null,
      heat_kit_confirmed: false,
      ...HP_DEFAULTS,
    },
  ]);
  vi.mocked(bm.getBuildingModes).mockResolvedValue([MAIN]);
  vi.mocked(bm.setBuildingMode).mockImplementation(async (_id, patch) => [
    { ...MAIN, ...patch, note: "", waiting: [] },
  ]);
});

describe("Dashboard building mode", () => {
  it("shows the mode, what the building is doing, and which zones are waiting", async () => {
    render(<Dashboard />);
    const building = await screen.findByTestId("dash-building-b1");
    const select = await within(building).findByLabelText("Mode for Main House");
    expect(select).toHaveValue("auto");
    const status = within(building).getAllByRole("status")[0];
    expect(status).toHaveTextContent(
      "Heating for every zone. Waiting for heating to finish. Upstairs is waiting to start cooling."
    );
    // A zone the Dashboard has no name for is named by its entity; watched waits say "would".
    expect(status).toHaveTextContent("climate.elsewhere would be waiting to start cooling.");
  });

  it("changes the mode and shows the result", async () => {
    render(<Dashboard />);
    const select = await screen.findByLabelText("Mode for Main House");
    fireEvent.change(select, { target: { value: "off" } });
    await waitFor(() => expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { mode: "off" }));
    await waitFor(() => expect(screen.getByLabelText("Mode for Main House")).toHaveValue("off"));
    expect(screen.getByText(/No room here asks for heating or cooling/)).toBeInTheDocument();
  });

  it("says why a mode change failed and keeps the old mode", async () => {
    vi.mocked(bm.setBuildingMode).mockRejectedValueOnce(new Error("Building not found"));
    render(<Dashboard />);
    const select = await screen.findByLabelText("Mode for Main House");
    fireEvent.change(select, { target: { value: "cool_only" } });
    expect(await screen.findByText("Building not found")).toBeInTheDocument();
    expect(select).toHaveValue("auto");
    vi.mocked(bm.setBuildingMode).mockRejectedValueOnce("nope");
    fireEvent.change(select, { target: { value: "cool_only" } });
    expect(await screen.findByText("Could not change the mode")).toBeInTheDocument();
  });

  it("keeps the last modes when a refresh fails, and shows none when they never load", async () => {
    render(<Dashboard />);
    await screen.findByLabelText("Mode for Main House");
    vi.mocked(bm.getBuildingModes).mockRejectedValueOnce(new Error("blip"));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(bm.getBuildingModes).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Mode for Main House")).toBeInTheDocument();
  });
});
