import { HP_DEFAULTS } from "../zoneFixtures";
/** Rooms page grouping by building and zone (HomeClimate). */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import Rooms from "./Rooms";
import * as api from "../api";
import * as zonesApi from "../zonesApi";
import { SystemContext, UnitContext, buildUnitContext } from "../contexts";
import { ecoThermostatDefaults, ecoRoomDefaults } from "../testFixtures";

vi.mock("../api");
vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getZones: vi.fn(),
  getBuildings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeThermostat = (over: Partial<api.ThermostatConfig> = {}): api.ThermostatConfig => ({
  thermostat_entity_id: "climate.test",
  name: "Test Thermostat",
  default_temp: 72,
  min_setpoint: 60,
  max_setpoint: 80,
  deadband: 0.5,
  max_vent_closed_min: 60,
  total_vents_count: null,
  has_bypass_damper: false,
  min_open_vents_fraction: 0.333,
  overshoot_delta: 0.5,
  cycle_timeout_hours: 2,
  reconciliation_interval_min: 5,
  vacation_hvac_mode: "single" as const,
  vacation_safety_cycles: true,
  min_cycle_runtime_min: 0,
  min_cycle_offtime_min: 0,
  cooling_lockout_below_f: null,
  overflow_during_min_runtime: true,
  unavailable_abort_after_min: 5,
  ...ecoThermostatDefaults,
  ...over,
});

const makeRoom = (over: Partial<api.Room> = {}): api.Room =>
  ({
    id: "room-1",
    name: "Living Room",
    thermostat_entity_id: "climate.test",
    include_thermostat_sensor: false,
    presence_holdover_hours: 2,
    temp_offset: 0,
    deadband_override: null,
    system_wide_temp: 72,
    notes: "",
    ambient_suppression_enabled: false,
    ambient_suppression_mode: "any_presence",
    ambient_suppression_min_differential: 5,
    ambient_suppression_deadband: 2,
    ambient_suppression_off_schedule_window_min: 60,
    ...ecoRoomDefaults,
    sensors: [{ id: "s1", room_id: "room-1", entity_id: "sensor.temp" }],
    vents: [{ id: "v1", room_id: "room-1", entity_id: "cover.vent", control_method: "open_close" }],
    presence_sensors: [],
    ...over,
  }) as api.Room;

const makeStatus = (over: Partial<api.RoomActiveStatus> = {}): api.RoomActiveStatus => ({
  room_id: "room-1",
  source: "idle",
  target_temp: null,
  ends_in_seconds: null,
  override_respect_eco: null,
  presence_holdover_active: false,
  presence_suppressed: false,
  next_schedule_in_seconds: null,
  next_schedule_target: null,
  next_schedule_label: null,
  ...over,
});

const mockSystem = { enabled: true, toggle: async () => {} };

/** Point getRooms / getRoom at the given rooms. */
function useRooms(rooms: api.Room[]) {
  vi.mocked(api.getRooms).mockResolvedValue(rooms);
  vi.mocked(api.getRoom).mockImplementation((id: string) =>
    Promise.resolve(rooms.find((r) => r.id === id) as api.Room)
  );
}

function renderPage(system: typeof mockSystem = mockSystem, unit: "F" | "C" = "F") {
  return render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <SystemContext.Provider value={system}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    </UnitContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useRooms([makeRoom()]);
  vi.mocked(api.getThermostats).mockResolvedValue([makeThermostat()]);
  vi.mocked(api.getRoomActiveStatuses).mockResolvedValue({ "room-1": makeStatus() });
  vi.mocked(api.getEntityStates).mockResolvedValue({});
  vi.mocked(api.getHAEntities).mockResolvedValue([]);
  vi.mocked(api.getOverrides).mockResolvedValue([]);
  vi.mocked(api.getSensorHealth).mockResolvedValue({ stale_after_min: 30, rooms: [] });
  vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
    entity_id: "sensor.outdoor",
    current_value: 80,
  });
});

const zone = (over: Partial<zonesApi.ZoneProfile>): zonesApi.ZoneProfile => ({
  thermostat_entity_id: "climate.test",
  name: "Upstairs",
  building_id: "b1",
  sort_order: 0,
  system_type: "conventional",
  compressor_stages: 1,
  backup_heat: "electric",
  equipment_running_entity: null,
  heat_kit_confirmed: false,
  ...HP_DEFAULTS,
  ...over,
});

describe("Rooms grouped by building and zone", () => {
  beforeEach(() => {
    vi.mocked(zonesApi.getBuildings).mockResolvedValue([
      { id: "b1", name: "Main House", sort_order: 0 },
      { id: "b2", name: "The Den", sort_order: 1 },
    ]);
  });

  it("puts each room under its building and zone, with empty and unzoned groups", async () => {
    useRooms([
      makeRoom(),
      makeRoom({ id: "room-2", name: "Shop", thermostat_entity_id: "climate.unknown" }),
    ]);
    vi.mocked(api.getThermostats).mockResolvedValue([
      makeThermostat(),
      makeThermostat({ thermostat_entity_id: "climate.empty", name: "" }),
    ]);
    vi.mocked(zonesApi.getZones).mockResolvedValue([
      zone({}),
      zone({ thermostat_entity_id: "climate.empty", name: "", building_id: null }),
    ]);
    renderPage();
    const panel = await screen.findByRole("region", { name: "Upstairs" });
    expect(within(panel).getByText("Living Room")).toBeInTheDocument();
    expect(within(panel).getByText("Conventional, Electric Strips")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Edit Zone" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Main House" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Unassigned" })).toBeInTheDocument();
    const empty = screen.getByRole("region", { name: "climate.empty" });
    expect(
      within(empty).getByText(
        "This zone has no rooms. Add one — every zone needs at least one room."
      )
    ).toBeInTheDocument();
    // A room whose thermostat is not a zone is set apart, not hidden.
    const loose = screen.getByRole("heading", { name: "Rooms Without a Zone" });
    expect(
      within(loose.closest(".building-group") as HTMLElement).getByText("Shop")
    ).toBeInTheDocument();
    expect(
      screen.getByText("No zones in this building yet. Edit a zone to move it here.")
    ).toBeInTheDocument();
    // One page for structure: the header carries every way to add to it.
    for (const name of ["Add Building", "Add Zone", "Add Room"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Set Up from Home Assistant" })).toHaveAttribute(
      "href",
      "/import"
    );
  });

  it("says so when zones fail to load", async () => {
    vi.mocked(zonesApi.getZones).mockRejectedValue(new Error("down"));
    renderPage();
    expect(await screen.findByText("Could not load zones")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Main House" })).toBeNull();
  });

  it("reloads the zone list after a room is saved", async () => {
    vi.mocked(zonesApi.getZones).mockResolvedValue([zone({})]);
    vi.mocked(api.updateRoom).mockResolvedValue(makeRoom({ name: "Lounge" }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Room Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateRoom).toHaveBeenCalled());
    await screen.findByRole("region", { name: "Upstairs" });
    await waitFor(() => expect(zonesApi.getZones).toHaveBeenCalledTimes(2));
  });

  it("deletes a zone with its rooms from inside the zone, then reloads the house", async () => {
    vi.mocked(zonesApi.getZones).mockResolvedValue([zone({})]);
    vi.mocked(api.deleteThermostat).mockResolvedValue({ deleted: "climate.test" });
    renderPage();
    const panel = await screen.findByRole("region", { name: "Upstairs" });
    fireEvent.click(within(panel).getByRole("button", { name: "Edit Zone" }));
    expect(
      await within(panel).findByRole("heading", { name: "Thermostat Settings" })
    ).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Delete Zone" }));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent(
      'Delete the zone "Test Thermostat" and all of its rooms? This cannot be undone.'
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Zone" }));

    await waitFor(() => expect(api.deleteThermostat).toHaveBeenCalledWith("climate.test", true));
    await waitFor(() => expect(api.getRooms).toHaveBeenCalledTimes(2));
  });
});
