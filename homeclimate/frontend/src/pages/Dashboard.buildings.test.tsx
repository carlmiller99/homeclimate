/** The Dashboard's per-building heating/cooling mode. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import Dashboard from "./Dashboard";
import * as api from "../api";
import * as bm from "../buildingModeApi";
import * as zonesApi from "../zonesApi";
import { FAN_DEFAULTS, HP_DEFAULTS } from "../zoneFixtures";

vi.mock("../api");
// The plan card loads by itself and has its own tests.
vi.mock("../components/TodayCard", () => ({ default: () => null }));
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
  updateZone: vi.fn(),
}));

const zoneState = (over: Partial<bm.ZoneModeState>): bm.ZoneModeState => ({
  thermostat_entity_id: "climate.up",
  name: "Upstairs",
  mode: "follow",
  effective_mode: "auto",
  side: null,
  note: "",
  next_switch_at: null,
  waiting: null,
  held_for: null,
  in_use: false,
  ...over,
});

const MAIN: bm.BuildingMode = {
  building_id: "b1",
  name: "Main House",
  mode: "auto",
  opposite_allowed: false,
  switching: "often",
  switch_threshold: 3,
  zones: [
    zoneState({ thermostat_entity_id: "climate.den", name: "Den", side: "heating" }),
    zoneState({ mode: "cool", effective_mode: "cool", held_for: "cooling" }),
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
      ...FAN_DEFAULTS,
      mode: "cool",
    },
  ]);
  vi.mocked(zonesApi.updateZone).mockImplementation(
    async (tid, patch) =>
      ({ ...(await zonesApi.getZones())[0], thermostat_entity_id: tid, ...patch }) as never
  );
  vi.mocked(bm.getBuildingModes).mockResolvedValue([MAIN]);
  vi.mocked(bm.setBuildingMode).mockImplementation(async (_id, patch) => [
    { ...MAIN, ...patch, zones: [] },
  ]);
});

describe("Dashboard building mode", () => {
  it("shows the mode, what the building is doing, and which zones are waiting", async () => {
    render(<Dashboard />);
    const building = await screen.findByTestId("dash-building-b1");
    const select = await within(building).findByLabelText("Mode for Main House");
    expect(select).toHaveValue("auto");
    const status = within(building).getAllByRole("status")[0];
    expect(status).toHaveTextContent("Auto. Upstairs waits while Den heats.");
    // The zone's card says its mode, and why it waits.
    const card = screen.getByTestId("dash-zone-climate.up");
    expect(within(card).getByRole("button", { name: /^Settings for Upstairs / })).toHaveTextContent(
      "Cool"
    );
    expect(card).toHaveTextContent(
      "Set to Cool. Waits while Den heats, because zones in Main House may not run opposite each other."
    );
  });

  it("opens a zone's settings and changes its mode", async () => {
    // Another zone's profile is left as it was.
    const [up] = await zonesApi.getZones();
    vi.mocked(zonesApi.getZones).mockResolvedValue([
      up,
      { ...up, thermostat_entity_id: "climate.den", name: "Den", mode: "follow" },
    ]);
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole("button", { name: /^Settings for Upstairs / }));
    const dialog = screen.getByRole("dialog", { name: "Upstairs settings" });
    expect(dialog).toHaveTextContent("Main House, Thermostat 68.0°F");
    expect(dialog).toHaveTextContent("Follow Main House, or set this zone's own.");
    const group = within(dialog).getByRole("radiogroup", { name: "Mode for Upstairs" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.textContent)
    ).toEqual(["Follow Building", "Auto", "Heat", "Cool", "Off"]);
    expect(within(group).getByRole("radio", { name: "Cool" })).toBeChecked();
    expect(dialog).toHaveTextContent(/^.*Set to Cool\. Waits while Den heats/);
    // The home's layout could not be read: no targets to set.
    expect(within(dialog).queryByText("Baseline Temperature Target")).toBeNull();
    fireEvent.click(within(group).getByRole("radio", { name: "Follow Building" }));
    await waitFor(() =>
      expect(zonesApi.updateZone).toHaveBeenCalledWith("climate.up", { mode: "follow" })
    );
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: "Follow Building" })).toBeChecked()
    );
    // The building's modes are read again, to show what the zone does now.
    await waitFor(() => expect(bm.getBuildingModes).toHaveBeenCalledTimes(2));
    vi.mocked(zonesApi.updateZone).mockRejectedValueOnce(new Error("Zone not found"));
    fireEvent.click(within(group).getByRole("radio", { name: "Heat" }));
    expect(await within(dialog).findByText("Zone not found")).toBeInTheDocument();
    vi.mocked(zonesApi.updateZone).mockRejectedValueOnce("nope");
    fireEvent.click(within(group).getByRole("radio", { name: "Heat" }));
    expect(await within(dialog).findByText("Could not change the mode")).toBeInTheDocument();
    // A failed read of the modes afterwards keeps what is shown.
    vi.mocked(bm.getBuildingModes).mockRejectedValueOnce(new Error("blip"));
    fireEvent.click(within(group).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(within(group).getByRole("radio", { name: "Off" })).toBeChecked());
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Upstairs settings" })).toBeNull();
  });

  it("offers a zone in no building Auto, Heat, Cool and Off", async () => {
    vi.mocked(zonesApi.getBuildings).mockResolvedValue([]);
    vi.mocked(bm.getBuildingModes).mockResolvedValue([]);
    vi.mocked(zonesApi.getZones).mockResolvedValue([
      {
        ...(await zonesApi.getZones())[0],
        building_id: null,
        mode: "follow",
      },
    ]);
    vi.mocked(api.getStatus).mockResolvedValue([
      { ...(await api.getStatus())[0], current_temp: null },
    ]);
    render(<Dashboard />);
    const open = await screen.findByRole("button", { name: /^Settings for Upstairs / });
    // Following nothing, it is in Auto.
    expect(open).toHaveTextContent("Auto");
    fireEvent.click(open);
    const dialog = screen.getByRole("dialog", { name: "Upstairs settings" });
    expect(dialog).toHaveTextContent("Auto switches between heating and cooling as rooms need it.");
    const group = within(dialog).getByRole("radiogroup", { name: "Mode for Upstairs" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.textContent)
    ).toEqual(["Auto", "Heat", "Cool", "Off"]);
    expect(within(group).getByRole("radio", { name: "Auto" })).toBeChecked();
    // Clicking the backdrop closes it.
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog", { name: "Upstairs settings" })).toBeNull();
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
