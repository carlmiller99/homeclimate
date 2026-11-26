/**
 * Rooms page — behavioural coverage for the branches the main suite leaves
 * open: the settings-form validation guards, the empty/absent-entity states,
 * the live-status permutations on the room card, and the two timers.
 *
 * Kept in its own file so `Rooms.test.tsx` stays the narrative suite; every
 * test here drives the public surface (render + user event) rather than
 * reaching into the module's private helpers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import Rooms from "./Rooms";
import * as api from "../api";
import * as zonesApi from "../zonesApi";
import * as sc from "../smartControlApi";
import { zoneFor, smartControl } from "../zoneFixtures";
import { SystemContext, UnitContext, buildUnitContext } from "../contexts";
import { ecoThermostatDefaults, ecoRoomDefaults } from "../testFixtures";

vi.mock("../api");
vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getZones: vi.fn(),
  getBuildings: vi.fn(),
}));
vi.mock("../smartControlApi", async (orig) => ({
  ...(await orig<typeof import("../smartControlApi")>()),
  getSmartControl: vi.fn(),
  saveContactSensor: vi.fn(),
  deleteContactSensor: vi.fn(),
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

// My Home reads the zone list, buildings and door/window sensors too. A zone
// exists for every registered thermostat, as the backend guarantees.
beforeEach(() => {
  vi.mocked(zonesApi.getBuildings).mockResolvedValue([]);
  vi.mocked(zonesApi.getZones).mockImplementation(async () =>
    ((await api.getThermostats()) ?? []).map((t) => zoneFor(t.thermostat_entity_id, t.name))
  );
  vi.mocked(sc.getSmartControl).mockResolvedValue(smartControl() as sc.SmartControl);
  vi.mocked(api.getSensorHealth).mockResolvedValue({ stale_after_min: 30, rooms: [] });
});

// ---------------------------------------------------------------------------
// Room settings form — validation guards
// ---------------------------------------------------------------------------

describe("Rooms settings form — validation guards", () => {
  const openNewRoom = async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Add Room"));
    await screen.findByText("New Room", { selector: ".page-title" });
  };

  it("requires a thermostat before creating a room", async () => {
    await openNewRoom();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Den" } });
    // The form opens on the zone whose Add Room button was pressed.
    const zonePicker = screen.getByRole("combobox", { name: /Thermostat/i });
    expect(zonePicker).toHaveValue("climate.test");
    fireEvent.change(zonePicker, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    expect(await screen.findByText("Thermostat is required")).toBeInTheDocument();
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("rejects a deadband override above the documented maximum", async () => {
    await openNewRoom();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Den" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Thermostat/i }), {
      target: { value: "climate.test" },
    });
    fireEvent.change(screen.getByLabelText(/Deadband override/i), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    expect(
      await screen.findByText("Deadband override must be between 0°F and 10°F")
    ).toBeInTheDocument();
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("rejects a widened deadband below the thermostat's own deadband", async () => {
    await openNewRoom();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Den" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Thermostat/i }), {
      target: { value: "climate.test" },
    });
    const toggle = await screen.findByLabelText(/pre-cool \/ pre-heat/i);
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);

    fireEvent.change(screen.getByLabelText(/Widened deadband/i), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    expect(
      await screen.findByText(
        "Pre-cool/pre-heat: widened deadband must be at least the thermostat's deadband (0.5°F)"
      )
    ).toBeInTheDocument();
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("rejects a negative pre-cool/pre-heat minimum outside difference", async () => {
    await openNewRoom();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Den" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Thermostat/i }), {
      target: { value: "climate.test" },
    });
    const toggle = await screen.findByLabelText(/pre-cool \/ pre-heat/i);
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);

    fireEvent.change(screen.getByLabelText(/Minimum outside difference/i), {
      target: { value: "-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    expect(
      await screen.findByText("Pre-cool/pre-heat: minimum outside difference must be 0 or greater")
    ).toBeInTheDocument();
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("reveals the schedule-window field in off_schedule_only mode and rejects a negative window", async () => {
    await openNewRoom();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Den" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Thermostat/i }), {
      target: { value: "climate.test" },
    });
    const toggle = await screen.findByLabelText(/pre-cool \/ pre-heat/i);
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);

    // "Any presence" hides the window field entirely.
    expect(screen.queryByLabelText(/Schedule window/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/When to apply/i), {
      target: { value: "off_schedule_only" },
    });
    const windowInput = screen.getByLabelText(/Schedule window/i);
    expect(windowInput).toHaveValue(60);

    fireEvent.change(windowInput, { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    expect(
      await screen.findByText("Pre-cool/pre-heat: schedule window must be 0 or greater")
    ).toBeInTheDocument();
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("submits an explicit 0 for every zeroed numeric field", async () => {
    // A thermostat with a 0 deadband is the only way a 0 widened deadband
    // passes the >= thermostat-deadband guard, which is what lets all four
    // `parseFloat(...) || 0` fallbacks be exercised in one save.
    vi.mocked(api.getThermostats).mockResolvedValue([makeThermostat({ deadband: 0 })]);
    vi.mocked(api.createRoom).mockResolvedValue(makeRoom({ id: "room-9", name: "Zeroes" }));

    await openNewRoom();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Zeroes" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Thermostat/i }), {
      target: { value: "climate.test" },
    });
    fireEvent.change(screen.getByLabelText(/Presence holdover/i), { target: { value: "0" } });

    const toggle = await screen.findByLabelText(/pre-cool \/ pre-heat/i);
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText(/When to apply/i), {
      target: { value: "off_schedule_only" },
    });
    fireEvent.change(screen.getByLabelText(/Schedule window/i), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/Minimum outside difference/i), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText(/Widened deadband/i), { target: { value: "0" } });

    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    await waitFor(() => expect(api.createRoom).toHaveBeenCalled());
    const [payload] = vi.mocked(api.createRoom).mock.calls[0];
    expect(payload).toMatchObject({
      presence_holdover_hours: 0,
      ambient_suppression_min_differential: 0,
      ambient_suppression_deadband: 0,
      ambient_suppression_off_schedule_window_min: 0,
      ambient_suppression_mode: "off_schedule_only",
    });
  });

  it("surfaces the API error message when the save is rejected", async () => {
    vi.mocked(api.createRoom).mockRejectedValue(new Error("Room name already taken"));
    await openNewRoom();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Den" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Thermostat/i }), {
      target: { value: "climate.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    expect(await screen.findByText("Room name already taken")).toBeInTheDocument();
    // The button is re-enabled by the finally block so the user can retry.
    expect(screen.getByRole("button", { name: /Create room/i })).not.toBeDisabled();
  });

  it("falls back to a generic message when the rejection is not an Error", async () => {
    vi.mocked(api.createRoom).mockRejectedValue("kaboom");
    await openNewRoom();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Den" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Thermostat/i }), {
      target: { value: "climate.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    expect(await screen.findByText("Save failed")).toBeInTheDocument();
  });

  it("points the user at Add Zone when the zones' thermostats did not load", async () => {
    // The zone is listed, so it has an Add Room button, but the form has no
    // thermostat to offer.
    vi.mocked(zonesApi.getZones).mockResolvedValue([zoneFor("climate.test", "Test")]);
    vi.mocked(api.getThermostats).mockResolvedValue([]);
    await openNewRoom();

    expect(screen.getByText(/No zones yet\. Go back to My Home and use/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Thermostat/i })).not.toBeInTheDocument();
  });

  it("keeps pre-cool/pre-heat locked when the outside-sensor probe fails", async () => {
    vi.mocked(api.getOutsideTempEntity).mockRejectedValue(new Error("HA offline"));
    await openNewRoom();

    const toggle = await screen.findByLabelText(/pre-cool \/ pre-heat/i);
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/Add an outside temperature sensor/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Configure view — empty / absent entity lists
// ---------------------------------------------------------------------------

describe("Rooms configure view", () => {
  const openConfigure = async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Devices" }));
    await screen.findByTestId("room-configure");
  };

  it("says in plain lines what a started room cannot do yet", async () => {
    // A presence sensor only: the room has been started but cannot be controlled.
    const started = makeRoom();
    started.sensors = [];
    started.vents = [];
    started.presence_sensors = [
      { entity_id: "binary_sensor.den_motion" },
    ] as api.Room["presence_sensors"];
    useRooms([started]);
    await openConfigure();
    expect(screen.queryByText(/Add this room's devices below/)).toBeNull();
    expect(
      screen.getByText(
        "No temperature sensors selected. This room cannot be controlled independently, or contribute temperature information, without them."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "No smart vents selected. This room cannot be controlled independently without them."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/No occupancy sensors selected/)).toBeNull();
  });

  it("notes only missing occupancy sensors on a room that has the rest", async () => {
    const room = makeRoom();
    room.presence_sensors = [];
    useRooms([room]);
    await openConfigure();
    expect(
      screen.getByText(
        "No occupancy sensors selected. This room cannot use occupancy smart features without them."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/No temperature sensors selected/)).toBeNull();
    expect(screen.queryByText(/No smart vents selected/)).toBeNull();
  });

  it("renders a setup hint, empty hints and plural counts for a room with no entities", async () => {
    // `sensors` / `vents` / `presence_sensors` absent entirely — the API omits
    // them on some payloads, so the `?? []` fallbacks must hold.
    const bare = makeRoom();
    delete (bare as Partial<api.Room>).sensors;
    delete (bare as Partial<api.Room>).vents;
    delete (bare as Partial<api.Room>).presence_sensors;
    useRooms([bare]);

    await openConfigure();

    // Quick-status strip pluralises on 0.
    expect(screen.getByText("temp sensors")).toBeInTheDocument();
    expect(screen.getByText("vents")).toBeInTheDocument();
    expect(screen.getByText("presence sensors")).toBeInTheDocument();

    // A room with nothing in it yet is being set up: it gets a hint, not warnings.
    expect(screen.getByText(/Add this room's devices below/)).toBeInTheDocument();
    expect(screen.queryByText(/No temperature sensors selected/)).toBeNull();
    expect(screen.queryByText(/No smart vents selected/)).toBeNull();

    // Empty hints from EntitySection / VentTable.
    expect(screen.getByText("No sensors added yet — search above to add one.")).toBeInTheDocument();
    expect(screen.getByText(/No vents added yet — search above to add one/i)).toBeInTheDocument();
    expect(
      screen.getByText("No occupancy sensors added — the room will only activate via schedules.")
    ).toBeInTheDocument();
  });

  it("adds a vent through the picker and re-reads the room afterwards", async () => {
    const withVent = makeRoom({
      vents: [
        { id: "v9", room_id: "room-1", entity_id: "cover.new_vent", control_method: "open_close" },
      ],
    });
    const without = makeRoom({ vents: [] });
    useRooms([without]);
    vi.mocked(api.getHAEntities).mockResolvedValue([
      { entity_id: "cover.new_vent", friendly_name: "New Vent", state: "" },
    ]);
    vi.mocked(api.addVent).mockImplementation(async () => {
      // After the add succeeds the configure view re-reads the room; return the
      // post-add shape so the refetch is observable in the DOM.
      vi.mocked(api.getRoom).mockResolvedValue(withVent);
      return { id: "v9", room_id: "room-1", entity_id: "cover.new_vent" } as never;
    });

    await openConfigure();
    const picker = screen.getByPlaceholderText(/Search vents/i);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: "new" } });
    fireEvent.mouseDown(await screen.findByText("New Vent"));

    await waitFor(() => expect(api.addVent).toHaveBeenCalledWith("room-1", "cover.new_vent"));
    // The refresh landed: the vent table now lists the entity.
    expect(await screen.findByText("cover.new_vent")).toBeInTheDocument();
    expect(screen.queryByText(/No vents added yet/i)).not.toBeInTheDocument();
  });

  it("falls back to the raw entity id when the room's thermostat is not registered", async () => {
    useRooms([makeRoom({ thermostat_entity_id: "climate.ghost" })]);
    await openConfigure();

    const header = screen.getByTestId("room-configure");
    // No matching ThermostatConfig → the id stands in for the friendly name and
    // is therefore rendered twice (name slot + the parenthesised mono id).
    expect(within(header).getAllByText(/climate\.ghost/)).toHaveLength(2);
  });

  it("shows a positive temperature offset in the quick-status strip", async () => {
    useRooms([makeRoom({ temp_offset: 2 })]);
    await openConfigure();
    expect(screen.getByText("+2°F")).toBeInTheDocument();
  });

  it("shows a negative temperature offset without a plus sign", async () => {
    useRooms([makeRoom({ temp_offset: -1.5 })]);
    await openConfigure();
    expect(screen.getByText("-1.5°F")).toBeInTheDocument();
  });

  it("reports a failed vent test on the row", async () => {
    vi.mocked(api.testVent).mockRejectedValue(new Error("service not found"));
    await openConfigure();

    fireEvent.click(screen.getByText("Test open"));

    expect(await screen.findByText(/service not found/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Room card — one equal section per kind of device
// ---------------------------------------------------------------------------

const contact = (over: Partial<sc.ContactSensor> = {}): sc.ContactSensor => ({
  entity_id: "binary_sensor.door",
  name: "Patio Door",
  thermostat_entity_id: null,
  room_id: "room-1",
  pauses: "room",
  state: "closed",
  open_since: null,
  pausing: false,
  ...over,
});

const state = (
  s: string,
  attributes: Record<string, unknown> = {},
  numeric: number | null = null
): api.EntityState => ({ state: s, numeric, unit: "", attributes });

/** The four device sections of the (only) room card. */
const section = (name: string) => screen.getByRole("region", { name });

/** [name, value] for every device listed in a section. */
const devices = (name: string) =>
  [...section(name).querySelectorAll(".device-item")].map((li) => [
    li.querySelector(".device-name")?.textContent,
    li.querySelector(".device-value")?.textContent,
  ]);

describe("Room card — devices", () => {
  it("gives each kind of device its own section, in a fixed order", async () => {
    const { container } = renderPage();
    await screen.findByText("Living Room");
    const titles = [...container.querySelectorAll(".device-section")].map((s) =>
      s.getAttribute("aria-label")
    );
    expect(titles).toEqual([
      "Smart Vents",
      "Temperature Sensors",
      "Doors & Windows",
      "Occupancy Sensors",
    ]);
    // The card edits hardware only: no manual controls live here any more.
    expect(screen.getByRole("button", { name: "Edit Devices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Room Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Hold/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear presence/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("renders a room with no sensors, vents or presence sensors", async () => {
    const bare = makeRoom();
    delete (bare as Partial<api.Room>).sensors;
    delete (bare as Partial<api.Room>).vents;
    delete (bare as Partial<api.Room>).presence_sensors;
    useRooms([bare]);

    renderPage();
    await screen.findByText("Living Room");

    // No entity ids at all → the HA state fetch is skipped entirely.
    expect(api.getEntityStates).not.toHaveBeenCalled();
    expect(within(section("Smart Vents")).getByText("No vents")).toBeInTheDocument();
    expect(within(section("Temperature Sensors")).getByText("No sensors")).toBeInTheDocument();
    expect(within(section("Doors & Windows")).getByText("None")).toBeInTheDocument();
    expect(within(section("Occupancy Sensors")).getByText("None")).toBeInTheDocument();
    for (const name of ["Smart Vents", "Temperature Sensors", "Doors & Windows"]) {
      expect(section(name).querySelector(".device-count")).toHaveTextContent("0");
    }
  });

  it("keeps rendering, with placeholders, when the HA state fetch fails", async () => {
    useRooms([
      makeRoom({
        presence_sensors: [{ id: "p1", room_id: "room-1", entity_id: "binary_sensor.motion" }],
      }),
    ]);
    vi.mocked(api.getEntityStates).mockRejectedValue(new Error("HA down"));
    renderPage();
    await screen.findByText("Living Room");
    await waitFor(() => expect(api.getEntityStates).toHaveBeenCalled());

    // No state arrived → the entity id as the name and an ellipsis as the value.
    expect(devices("Smart Vents")).toEqual([["cover.vent", "…"]]);
    expect(devices("Temperature Sensors")).toEqual([["sensor.temp", "…"]]);
    expect(devices("Occupancy Sensors")).toEqual([["binary_sensor.motion", "…"]]);
  });

  it("renders every vent-position flavour", async () => {
    useRooms([
      makeRoom({
        vents: [
          { id: "v0", room_id: "room-1", entity_id: "cover.wide", control_method: "open_close" },
          { id: "v1", room_id: "room-1", entity_id: "cover.tilt", control_method: "open_close" },
          { id: "v2", room_id: "room-1", entity_id: "cover.half", control_method: "open_close" },
          { id: "v3", room_id: "room-1", entity_id: "cover.plain", control_method: "open_close" },
          { id: "v4", room_id: "room-1", entity_id: "cover.shut", control_method: "open_close" },
          { id: "v5", room_id: "room-1", entity_id: "cover.weird", control_method: "open_close" },
        ],
      }),
    ]);
    vi.mocked(api.getEntityStates).mockResolvedValue({
      // A fully-open standard cover, a Flair-style tilt at 0, and a mid
      // position → "Open", "Closed" and a percentage respectively.
      "cover.wide": state("closed", { current_position: 100, friendly_name: "Wide Vent" }),
      "cover.tilt": state("open", { current_tilt_position: 0, friendly_name: "" }),
      "cover.half": state("open", { current_position: 55, friendly_name: 7 }),
      // No position attributes at all → fall back to the cover state string.
      "cover.plain": state("open"),
      "cover.shut": state("closed"),
      "cover.weird": state("unavailable"),
    });
    renderPage();
    await screen.findByText("Living Room");

    await waitFor(() =>
      // "cover.wide" reads Open from its position even though its state string
      // says closed — the position attribute wins over the state fallback. A
      // blank or non-text friendly name falls back to the entity id.
      expect(devices("Smart Vents")).toEqual([
        ["Wide Vent", "Open"],
        ["cover.tilt", "Closed"],
        ["cover.half", "55%"],
        ["cover.plain", "Open"],
        ["cover.shut", "Closed"],
        ["cover.weird", "unavailable"],
      ])
    );
    expect(section("Smart Vents").querySelector(".device-count")).toHaveTextContent("6");
  });

  it("shows each temperature sensor's reading in the display unit, and flags stale ones", async () => {
    useRooms([
      makeRoom({
        sensors: [
          { id: "s1", room_id: "room-1", entity_id: "sensor.temp" },
          { id: "s2", room_id: "room-1", entity_id: "sensor.old" },
          { id: "s3", room_id: "room-1", entity_id: "sensor.quiet" },
        ],
      }),
    ]);
    vi.mocked(api.getEntityStates).mockResolvedValue({
      "sensor.temp": state("68", { friendly_name: "Sofa" }, 68),
      "sensor.old": state("70", {}, 70),
      "sensor.quiet": state("unknown"),
    });
    vi.mocked(api.getSensorHealth).mockResolvedValue({
      stale_after_min: 30,
      rooms: [
        {
          room_id: "room-1",
          room_name: "Living Room",
          thermostat_entity_id: "climate.test",
          stale_sensors: [{ entity_id: "sensor.old", age_seconds: 5400, reason: "stale" }],
        },
      ],
    });
    renderPage(mockSystem, "C");
    await screen.findByText("Living Room");

    await waitFor(() =>
      expect(devices("Temperature Sensors")).toEqual([
        ["Sofa", "20.0°C"],
        ["sensor.old", "Stale"],
        ["sensor.quiet", "…"],
      ])
    );
    expect(within(section("Temperature Sensors")).getByText("Stale")).toHaveClass("device-warn");
    expect(within(section("Temperature Sensors")).getByText("20.0°C")).not.toHaveClass(
      "device-warn"
    );
  });

  it("lists this room's doors and windows with their state and what they pause", async () => {
    vi.mocked(sc.getSmartControl).mockResolvedValue(
      smartControl([
        contact({ state: "open", pauses: "zone" }),
        contact({ entity_id: "binary_sensor.win", name: "Bay Window" }),
        contact({ entity_id: "binary_sensor.dead", name: "Side Door", state: "offline" }),
        // Another room's sensor never shows on this card.
        contact({ entity_id: "binary_sensor.other", name: "Garage Door", room_id: "room-9" }),
      ]) as sc.SmartControl
    );
    renderPage();
    await screen.findByText("Living Room");

    await waitFor(() =>
      expect(devices("Doors & Windows")).toEqual([
        ["Patio Door", "OpenZone"],
        ["Bay Window", "Closed"],
        ["Side Door", "Offline"],
      ])
    );
    const doors = section("Doors & Windows");
    expect(within(doors).getByText("Zone")).toHaveClass("device-tag");
    expect(doors.querySelectorAll(".device-tag")).toHaveLength(1);
    expect(doors.querySelector(".device-open")).toHaveTextContent("Open");
    expect(doors.querySelectorAll(".device-open")).toHaveLength(1);
    expect(screen.queryByText("Garage Door")).toBeNull();
  });

  it("shows no doors or windows when Smart Control cannot be read", async () => {
    vi.mocked(sc.getSmartControl).mockRejectedValue(new Error("down"));
    renderPage();
    await screen.findByText("Living Room");
    await waitFor(() => expect(sc.getSmartControl).toHaveBeenCalled());
    expect(within(section("Doors & Windows")).getByText("None")).toBeInTheDocument();
  });

  it("reads occupancy sensors as Occupied, Clear or Offline", async () => {
    useRooms([
      makeRoom({
        presence_sensors: [
          { id: "p1", room_id: "room-1", entity_id: "binary_sensor.desk" },
          { id: "p2", room_id: "room-1", entity_id: "binary_sensor.sofa" },
          { id: "p3", room_id: "room-1", entity_id: "binary_sensor.lost" },
          { id: "p4", room_id: "room-1", entity_id: "binary_sensor.late" },
        ],
      }),
    ]);
    vi.mocked(api.getEntityStates).mockResolvedValue({
      "binary_sensor.desk": state("on", { friendly_name: "Desk" }),
      "binary_sensor.sofa": state("off"),
      "binary_sensor.lost": state("unavailable"),
      // HA has no state for this one yet.
      "binary_sensor.late": null,
    });
    renderPage();
    await screen.findByText("Living Room");

    await waitFor(() =>
      expect(devices("Occupancy Sensors")).toEqual([
        ["Desk", "Occupied"],
        ["binary_sensor.sofa", "Clear"],
        ["binary_sensor.lost", "Offline"],
        ["binary_sensor.late", "…"],
      ])
    );
    const occupancy = section("Occupancy Sensors");
    expect(occupancy.querySelectorAll(".device-occupied")).toHaveLength(1);
    expect(within(occupancy).getByText("Occupied")).toHaveClass("device-occupied");
  });

  it("keeps the stale badge singular for exactly one sensor", async () => {
    vi.mocked(api.getSensorHealth).mockResolvedValue({
      stale_after_min: 30,
      rooms: [
        {
          room_id: "room-1",
          room_name: "Living Room",
          thermostat_entity_id: "climate.test",
          stale_sensors: [{ entity_id: "sensor.one", age_seconds: 5400, reason: "stale" }],
        },
      ],
    });
    renderPage();

    const badge = await screen.findByTestId("stale-badge-room-1");
    expect(badge.textContent).toBe("1 stale sensor");
    expect(badge.getAttribute("title")).toBe("sensor.one — 1.5 h ago");
  });

  it("pluralises the stale badge and formats every staleness age", async () => {
    vi.mocked(api.getSensorHealth).mockResolvedValue({
      stale_after_min: 30,
      rooms: [
        {
          room_id: "room-1",
          room_name: "Living Room",
          thermostat_entity_id: "climate.test",
          stale_sensors: [
            { entity_id: "sensor.never", age_seconds: null, reason: "not_in_cache" },
            { entity_id: "sensor.null_age", age_seconds: null, reason: "stale" },
            { entity_id: "sensor.minutes", age_seconds: 120, reason: "stale" },
            { entity_id: "sensor.days", age_seconds: 172800, reason: "stale" },
          ],
        },
      ],
    });
    renderPage();

    const badge = await screen.findByTestId("stale-badge-room-1");
    // Exact text, not a substring: a hardcoded "s" would still satisfy
    // toHaveTextContent("… stale sensor") and leave the plural unpinned.
    expect(badge.textContent).toBe("4 stale sensors");
    const title = badge.getAttribute("title") ?? "";
    expect(title).toContain("sensor.never — never seen by HA");
    expect(title).toContain("sensor.null_age — never seen by HA");
    expect(title).toContain("sensor.minutes — 2 min ago");
    expect(title).toContain("sensor.days — 2 d ago");
  });

  it("shows no stale badge when sensor health cannot be read", async () => {
    vi.mocked(api.getSensorHealth).mockRejectedValue(new Error("down"));
    renderPage();
    await screen.findByText("Living Room");
    await waitFor(() => expect(api.getSensorHealth).toHaveBeenCalled());
    expect(screen.queryByTestId("stale-badge-room-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Doors & Windows inside Edit Devices
// ---------------------------------------------------------------------------

describe("Edit Devices — doors and windows", () => {
  const open = async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Devices" }));
    await screen.findByPlaceholderText(/Search door and window sensors/);
  };

  it("adds a door to the room, pausing the room by default", async () => {
    vi.mocked(api.getHAEntities).mockResolvedValue([
      { entity_id: "binary_sensor.door", friendly_name: "Patio Door", state: "" },
    ]);
    vi.mocked(sc.saveContactSensor).mockResolvedValue(smartControl([contact()]) as sc.SmartControl);
    await open();
    expect(screen.getByText("No doors or windows in this room.")).toBeInTheDocument();

    const picker = screen.getByPlaceholderText(/Search door and window sensors/);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: "patio" } });
    fireEvent.mouseDown(await screen.findByText("Patio Door"));

    await waitFor(() =>
      expect(sc.saveContactSensor).toHaveBeenCalledWith("binary_sensor.door", {
        room_id: "room-1",
        pauses: "room",
      })
    );
    expect(await screen.findByLabelText("What Patio Door pauses")).toHaveValue("room");
    expect(screen.queryByText("No doors or windows in this room.")).toBeNull();
  });

  it("switches a door between pausing the room and the whole zone, and removes it", async () => {
    vi.mocked(sc.getSmartControl).mockResolvedValue(
      smartControl([
        contact(),
        contact({ entity_id: "binary_sensor.other", name: "Garage Door", room_id: "room-9" }),
      ]) as sc.SmartControl
    );
    vi.mocked(sc.saveContactSensor).mockResolvedValue(
      smartControl([contact({ pauses: "zone" })]) as sc.SmartControl
    );
    vi.mocked(sc.deleteContactSensor).mockResolvedValue(smartControl() as sc.SmartControl);
    await open();
    // Only this room's sensors are listed.
    expect(screen.queryByText("Garage Door")).toBeNull();

    const scope = await screen.findByLabelText("What Patio Door pauses");
    fireEvent.change(scope, { target: { value: "zone" } });
    await waitFor(() =>
      expect(sc.saveContactSensor).toHaveBeenCalledWith("binary_sensor.door", {
        room_id: "room-1",
        pauses: "zone",
      })
    );
    await waitFor(() =>
      expect(screen.getByLabelText("What Patio Door pauses")).toHaveValue("zone")
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Patio Door" }));
    await waitFor(() => expect(sc.deleteContactSensor).toHaveBeenCalledWith("binary_sensor.door"));
    expect(await screen.findByText("No doors or windows in this room.")).toBeInTheDocument();
  });

  it("reports failures to add, change and remove a sensor", async () => {
    vi.mocked(sc.getSmartControl).mockResolvedValue(smartControl([contact()]) as sc.SmartControl);
    vi.mocked(api.getHAEntities).mockResolvedValue([
      { entity_id: "binary_sensor.win", friendly_name: "Bay Window", state: "" },
    ]);
    await open();
    const scope = await screen.findByLabelText("What Patio Door pauses");

    vi.mocked(sc.saveContactSensor).mockRejectedValueOnce(new Error("That room does not exist"));
    fireEvent.change(scope, { target: { value: "zone" } });
    expect(await screen.findByText("That room does not exist")).toBeInTheDocument();
    vi.mocked(sc.saveContactSensor).mockRejectedValueOnce(0);
    fireEvent.change(scope, { target: { value: "zone" } });
    expect(await screen.findByText("Could not save the sensor")).toBeInTheDocument();

    vi.mocked(sc.deleteContactSensor).mockRejectedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Remove Patio Door" }));
    expect(await screen.findByText("Could not remove the sensor")).toBeInTheDocument();

    vi.mocked(sc.saveContactSensor).mockRejectedValueOnce("x");
    const picker = screen.getByPlaceholderText(/Search door and window sensors/);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: "bay" } });
    fireEvent.mouseDown(await screen.findByText("Bay Window"));
    expect(await screen.findByText("Could not add the sensor")).toBeInTheDocument();
    // The list is unchanged by a failed write.
    expect(screen.getByLabelText("What Patio Door pauses")).toHaveValue("room");
  });
});

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

describe("My Home — timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Flush the mount promise chain without relying on waitFor's timers. */
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await act(async () => {});
    }
  };

  it("re-polls sensor health every 30 seconds, and nothing else", async () => {
    const { unmount } = renderPage();
    await flush();

    expect(api.getSensorHealth).toHaveBeenCalledTimes(1);
    expect(api.getRooms).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();

    expect(api.getSensorHealth).toHaveBeenCalledTimes(2);
    expect(api.getRooms).toHaveBeenCalledTimes(1);

    // The poll stops with the page.
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(api.getSensorHealth).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Page-level edge cases
// ---------------------------------------------------------------------------

describe("My Home — page edge cases", () => {
  it("shows a loading line until the house has been read", async () => {
    renderPage();
    expect(screen.getByText(/Loading My Home…/)).toBeInTheDocument();
    await screen.findByText("Living Room");
    expect(screen.queryByText(/Loading My Home…/)).toBeNull();
  });

  it("invites the first zone when the house is empty", async () => {
    useRooms([]);
    vi.mocked(api.getThermostats).mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText(/Nothing here yet\. Add a building, then add its zones/)
    ).toBeInTheDocument();
    expect(screen.queryByText("Rooms Without a Zone")).toBeNull();
  });

  it("says a zone with no rooms needs one", async () => {
    useRooms([]);
    renderPage();
    expect(
      await screen.findByText(
        "This zone has no rooms. Add one — every zone needs at least one room."
      )
    ).toBeInTheDocument();
  });

  it("lists rooms whose thermostat is not a zone, so they can be given one", async () => {
    useRooms([
      makeRoom(),
      makeRoom({ id: "room-2", name: "Attic", thermostat_entity_id: "climate.gone" }),
    ]);
    renderPage();
    const heading = await screen.findByRole("heading", { name: "Rooms Without a Zone" });
    const group = heading.closest(".building-group") as HTMLElement;
    expect(within(group).getByText("Attic")).toBeInTheDocument();
    expect(within(group).queryByText("Living Room")).toBeNull();
    expect(
      within(group).getByText("Open Room Settings and choose a zone for each of these rooms.")
    ).toBeInTheDocument();
    // The zoned room sits inside its zone's panel.
    expect(
      within(await screen.findByRole("region", { name: "Test Thermostat" })).getByText(
        "Living Room"
      )
    ).toBeInTheDocument();
  });

  it("cancels the outside-sensor probe when the settings form unmounts first", async () => {
    // The probe's `cancelled` flag exists so a late resolve cannot write into a
    // torn-down form. Leave it pending, unmount via Cancel, then resolve.
    let resolveProbe: (v: {
      entity_id: string | null;
      current_value: number | null;
    }) => void = () => {};
    vi.mocked(api.getOutsideTempEntity).mockReturnValue(
      new Promise((res) => {
        resolveProbe = res;
      })
    );

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Settings/i }));
    await screen.findByTestId("room-settings");

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() => expect(screen.queryByTestId("room-settings")).not.toBeInTheDocument());

    await act(async () => {
      resolveProbe({ entity_id: "sensor.outdoor", current_value: 80 });
    });

    // The list view is intact and a fresh mount still picks the probe up.
    expect(screen.getByText("Living Room")).toBeInTheDocument();
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 80,
    });
    fireEvent.click(screen.getByRole("button", { name: /Settings/i }));
    const toggle = await screen.findByLabelText(/pre-cool \/ pre-heat/i);
    await waitFor(() => expect(toggle).not.toBeDisabled());
  });
});

describe("Rooms configure view — refresh after a mutation", () => {
  it("re-reads the room after adding a sensor so the tag list reflects the server", async () => {
    const before = makeRoom({ sensors: [] });
    const after = makeRoom({
      sensors: [{ id: "s2", room_id: "room-1", entity_id: "sensor.new_temp" }],
    });
    useRooms([before]);
    vi.mocked(api.getHAEntities).mockResolvedValue([
      { entity_id: "sensor.new_temp", friendly_name: "New Temp", state: "" },
    ]);
    vi.mocked(api.addSensor).mockImplementation(async () => {
      vi.mocked(api.getRoom).mockResolvedValue(after);
      return { id: "s2", room_id: "room-1", entity_id: "sensor.new_temp" };
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Devices" }));
    await screen.findByTestId("room-configure");
    expect(screen.getByText("No sensors added yet — search above to add one.")).toBeInTheDocument();

    const picker = screen.getByPlaceholderText(/Search temperature sensors/i);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: "new" } });
    fireEvent.mouseDown(await screen.findByText("New Temp"));

    await waitFor(() => expect(api.addSensor).toHaveBeenCalledWith("room-1", "sensor.new_temp"));
    // Only a real refetch can put the server's sensor into the tag list.
    expect(await screen.findByText("sensor.new_temp")).toBeInTheDocument();
    expect(screen.queryByText("No sensors added yet — search above to add one.")).toBeNull();
  });
});
