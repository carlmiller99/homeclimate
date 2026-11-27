import { describe, it, expect, vi, beforeEach } from "vitest"; // trigger CI
import { ecoThermostatDefaults, ecoRoomDefaults } from "../testFixtures";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import Rooms from "./Rooms";
import RoomsSection from "../test/TuningHarness";
import * as api from "../api";
import * as zonesApi from "../zonesApi";
import * as sc from "../smartControlApi";
import { zoneFor, smartControl } from "../zoneFixtures";
import { SystemContext, UnitContext, buildUnitContext } from "../contexts";

vi.mock("../components/OutsideTempPicker", () => ({ default: () => <p>outside sensors</p> }));
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

const mockThermostats: api.ThermostatConfig[] = [
  {
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
    vacation_safety_cycles: true,
    min_cycle_runtime_min: 0,
    min_cycle_offtime_min: 0,
    cooling_lockout_below_f: null,
    overflow_during_min_runtime: true,
    unavailable_abort_after_min: 5,
    ...ecoThermostatDefaults,
  },
];

const mockRooms: api.Room[] = [
  {
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
    presence_sensors: [{ id: "p1", room_id: "room-1", entity_id: "binary_sensor.existing_motion" }],
  },
];

const mockSystem = {
  enabled: true,
  toggle: async () => {},
};

// File-level defaults for the mount fetches every describe below triggers but
// only some of them stub.
//
// `vi.mock("../api")` makes each export return `undefined`, and the Rooms page
// calls `.then()` on the result of these — so a describe that forgets one only
// survives because an EARLIER describe's `beforeEach` already installed an
// implementation (`vi.clearAllMocks()` clears call history, not implementations,
// so the leftover leaks forward). That made the file order-dependent: under
// `--sequence.shuffle` the "Celsius mode" block could run first and every test
// in it died with "Cannot read properties of undefined (reading 'then')".
//
// This runs before each describe's own `beforeEach`, so any block that wants
// different values still just overrides them.
beforeEach(() => {
  vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
    entity_id: null,
    current_value: null,
  });
  vi.mocked(api.getEntityStates).mockResolvedValue({});
  vi.mocked(api.getHAEntities).mockResolvedValue([]);
  vi.mocked(api.getOverrides).mockResolvedValue([]);
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

function renderTuning() {
  return render(<RoomsSection />);
}
function renderTuningInCelsius() {
  return render(
    <UnitContext.Provider value={buildUnitContext("C")}>
      <RoomsSection />
    </UnitContext.Provider>
  );
}

function renderPage() {
  return render(
    <SystemContext.Provider value={mockSystem}>
      <MemoryRouter>
        <Rooms />
      </MemoryRouter>
    </SystemContext.Provider>
  );
}

/** Opens one kind of device for the room, from its box on the room's card. */
async function openDevices(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: `${title} in Living Room` }));
  return screen.getByRole("dialog", { name: `${title} in Living Room` });
}
const closeDevices = () => fireEvent.click(screen.getByRole("button", { name: "Close" }));

describe("Rooms Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getRooms).mockResolvedValue(mockRooms);
    vi.mocked(api.getThermostats).mockResolvedValue(mockThermostats);
    vi.mocked(api.getRoom).mockImplementation((id: string) =>
      Promise.resolve(mockRooms.find((r) => r.id === id) as api.Room)
    );
    vi.mocked(api.getRoomActiveStatuses).mockResolvedValue({
      "room-1": {
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
      },
    });
    vi.mocked(api.getEntityStates).mockResolvedValue({
      "sensor.temp": { state: "72.5", numeric: 72.5, unit: "°F", attributes: {} },
      "cover.vent": {
        state: "open",
        numeric: null,
        unit: "",
        attributes: { current_position: 100 },
      },
    });
    vi.mocked(api.getHAEntities).mockResolvedValue([
      { entity_id: "sensor.another_temp", friendly_name: "Another Temp", state: "" },
      { entity_id: "cover.another_vent", friendly_name: "Another Vent", state: "" },
      { entity_id: "binary_sensor.motion", friendly_name: "Motion", state: "" },
    ]);
    // Default: an outside sensor is configured, so pre-cool/pre-heat is enabled.
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 80,
    });
  });

  it("renders the rooms list", async () => {
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    expect(await screen.findByText("Living Room")).toBeInTheDocument();
    expect(screen.getByText(/Test Thermostat/)).toBeInTheDocument();
    expect(await screen.findByText("72.5°F")).toBeInTheDocument();
  });

  it("shows validation error for empty room name", async () => {
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    const addBtn = await screen.findByText("Add Room");
    fireEvent.click(addBtn);

    const createBtn = await screen.findByRole("button", { name: /Create room/i });
    fireEvent.click(createBtn);

    expect(await screen.findByText("Room name is required")).toBeInTheDocument();
  });

  it("shows validation error for negative holdover", async () => {
    renderTuning();
    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));
    fireEvent.change(screen.getByLabelText(/Presence holdover/i), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(await screen.findByText("Presence holdover must be >= 0")).toBeInTheDocument();
    expect(api.updateRoom).not.toHaveBeenCalled();
  });

  // Sanitized room-name uniqueness (#519). The backend enforces this too, but
  // the form checks it first so the user finds out while it is still in front
  // of them rather than via an API rejection.
  const openNewRoomForm = async () => {
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );
    fireEvent.click(await screen.findByText("Add Room"));
    await screen.findByText("New Room", { selector: ".page-title" });
    fireEvent.change(screen.getByRole("combobox", { name: /^Zone/ }), {
      target: { value: "climate.test" },
    });
  };

  it("rejects a room name that duplicates an existing one", async () => {
    await openNewRoomForm();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Living Room" } });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    expect(await screen.findByText(/Another room is already called/i)).toBeInTheDocument();
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("rejects a name that only differs by case or punctuation", async () => {
    // The rule applies to the sanitized form, so these collide even though the
    // raw strings differ.
    await openNewRoomForm();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "living room!" } });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    expect(await screen.findByText(/Another room is already called/i)).toBeInTheDocument();
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("rejects a name with no letters or numbers", async () => {
    await openNewRoomForm();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "!!!" } });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    expect(
      await screen.findByText(/must contain at least one letter or number/i)
    ).toBeInTheDocument();
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("allows a name that stays distinct after sanitizing", async () => {
    // The rule must not over-reach: a space survives sanitization, so this is a
    // genuinely different topic segment from "Living Room".
    vi.mocked(api.createRoom).mockResolvedValue({
      id: "room-9",
      name: "Living Rooms",
      thermostat_entity_id: "climate.test",
    } as api.Room);
    await openNewRoomForm();
    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Living Rooms" } });
    fireEvent.click(screen.getByRole("button", { name: /Create room/i }));

    await waitFor(() => expect(api.createRoom).toHaveBeenCalled());
  });

  it("successfully creates a room", async () => {
    vi.mocked(api.createRoom).mockResolvedValue({
      id: "room-2",
      name: "New Room",
      thermostat_entity_id: "climate.test",
    } as api.Room);

    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    const addBtn = await screen.findByText("Add Room");
    fireEvent.click(addBtn);

    await screen.findByText("New Room", { selector: ".page-title" });

    const nameInput = screen.getByLabelText(/Room name/i);
    fireEvent.change(nameInput, { target: { value: "New Room" } });

    const thermoSelect = screen.getByRole("combobox", { name: /^Zone/ });
    fireEvent.change(thermoSelect, { target: { value: "climate.test" } });

    const createBtn = screen.getByRole("button", { name: /Create room/i });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(api.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "New Room",
          thermostat_entity_id: "climate.test",
        })
      );
    });
  });

  it("handles room editing", async () => {
    vi.mocked(api.updateRoom).mockResolvedValue({ ...mockRooms[0], name: "Edited Name" });

    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    const editBtn = await screen.findByRole("button", { name: "Edit Living Room" });
    fireEvent.click(editBtn);

    const nameInput = screen.getByLabelText(/Room name/i);
    fireEvent.change(nameInput, { target: { value: "Edited Name" } });

    const saveBtn = screen.getByRole("button", { name: /Save changes/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.updateRoom).toHaveBeenCalledWith(
        "room-1",
        expect.objectContaining({
          name: "Edited Name",
        })
      );
    });
  });

  it("deletes a room from Room Settings after a confirmation", async () => {
    vi.mocked(api.deleteRoom).mockResolvedValue({ deleted: "room-1" });
    renderPage();

    // The card itself no longer carries a Delete button.
    await screen.findByText("Living Room");
    expect(screen.queryByRole("button", { name: /Delete Room/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit Living Room" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Room" }));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(within(dialog).getByText(/Living Room/)).toBeInTheDocument();
    expect(api.deleteRoom).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(api.deleteRoom).toHaveBeenCalledWith("room-1"));
    // Back on the list, reloaded.
    expect(await screen.findByRole("heading", { name: "My Home" })).toBeInTheDocument();
    await waitFor(() => expect(api.getRooms).toHaveBeenCalledTimes(2));
  });

  it("does not delete a room when the confirmation dialog is cancelled", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Living Room" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Room" }));
    const dialog = await screen.findByTestId("confirm-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(api.deleteRoom).not.toHaveBeenCalled();
  });

  it("explains why a zone's last room cannot be deleted", async () => {
    vi.mocked(api.deleteRoom).mockRejectedValueOnce(
      new Error(
        "A zone needs at least one room. Add another room first, or delete the zone instead."
      )
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Living Room" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Room" }));
    fireEvent.click(
      within(await screen.findByTestId("confirm-dialog")).getByRole("button", { name: "Delete" })
    );
    expect(
      await screen.findByText(
        "A zone needs at least one room. Add another room first, or delete the zone instead."
      )
    ).toBeInTheDocument();
    // Still on the settings page, with the room intact.
    expect(screen.getByRole("button", { name: "Delete Room" })).toBeInTheDocument();

    vi.mocked(api.deleteRoom).mockRejectedValueOnce("nope");
    fireEvent.click(screen.getByRole("button", { name: "Delete Room" }));
    fireEvent.click(
      within(await screen.findByTestId("confirm-dialog")).getByRole("button", { name: "Delete" })
    );
    expect(await screen.findByText("Could not delete the room")).toBeInTheDocument();
  });

  it("offers no Delete Room button while creating a room", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Add Room to / }));
    expect(await screen.findByRole("button", { name: "Create Room" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Room" })).toBeNull();
  });

  it("opens each kind of device from its box and manages entities", async () => {
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    // Each kind of device opens from its own box on the room's card.
    let devices = await openDevices("Temperature Sensors");

    // Add a sensor
    const sensorPicker = screen.getByPlaceholderText(/Search temperature sensors/i);
    fireEvent.focus(sensorPicker);
    fireEvent.change(sensorPicker, { target: { value: "another" } });
    const sensorOption = await screen.findByText("Another Temp");
    fireEvent.mouseDown(sensorOption);

    await waitFor(() => {
      expect(api.addSensor).toHaveBeenCalledWith("room-1", "sensor.another_temp");
    });

    // Remove a sensor — requires confirmation naming the entity
    fireEvent.click(within(devices).getAllByTitle("Remove")[0]);
    let dialog = await screen.findByTestId("confirm-dialog");
    expect(within(dialog).getByText(/sensor\.temp/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(api.removeSensor).toHaveBeenCalledWith("room-1", "sensor.temp");
    });
    // Only this kind of device is in the dialog.
    expect(screen.queryByText("Test open")).toBeNull();
    closeDevices();
    expect(screen.queryByRole("dialog")).toBeNull();

    // Test vent
    devices = await openDevices("Smart Vents");
    fireEvent.click(screen.getByText("Test open"));
    expect(api.testVent).toHaveBeenCalledWith("cover.vent", "open_close", "open");

    // Remove vent — requires confirmation naming the entity
    fireEvent.click(within(devices).getAllByTitle("Remove")[0]);
    dialog = await screen.findByTestId("confirm-dialog");
    expect(within(dialog).getByText(/"Vent"/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(api.removeVent).toHaveBeenCalledWith("room-1", "cover.vent");
    });
    closeDevices();

    // Remove a presence sensor — requires confirmation naming the entity
    devices = await openDevices("Occupancy Sensors");
    fireEvent.click(within(devices).getAllByTitle("Remove")[0]);
    dialog = await screen.findByTestId("confirm-dialog");
    expect(within(dialog).getByText(/binary_sensor\.existing_motion/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(api.removePresence).toHaveBeenCalledWith("room-1", "binary_sensor.existing_motion");
    });
    // A click outside the sheet closes it too.
    fireEvent.click(devices);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not remove sensor, vent, or presence sensor when confirmation is cancelled", async () => {
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    for (const title of ["Temperature Sensors", "Smart Vents", "Occupancy Sensors"]) {
      const devices = await openDevices(title);
      fireEvent.click(within(devices).getAllByTitle("Remove")[0]);
      const dialog = await screen.findByTestId("confirm-dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument());
      closeDevices();
    }

    expect(api.removeSensor).not.toHaveBeenCalled();
    expect(api.removeVent).not.toHaveBeenCalled();
    expect(api.removePresence).not.toHaveBeenCalled();
  });

  it("changes a vent's control method from its box on the room card", async () => {
    vi.mocked(api.updateVentControlMethod).mockResolvedValue({
      updated: true,
      control_method: "set_position",
    });
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    await openDevices("Smart Vents");

    const methodSelect = screen.getByDisplayValue(/Open \/ close/i);
    fireEvent.change(methodSelect, { target: { value: "set_position" } });

    await waitFor(() => {
      expect(api.updateVentControlMethod).toHaveBeenCalledWith(
        "room-1",
        "cover.vent",
        "set_position"
      );
    });
  });

  it("reports a failure when changing the vent control method errors", async () => {
    vi.mocked(api.updateVentControlMethod).mockRejectedValue(new Error("nope"));
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    await openDevices("Smart Vents");

    const methodSelect = screen.getByDisplayValue(/Open \/ close/i) as HTMLSelectElement;
    fireEvent.change(methodSelect, { target: { value: "toggle" } });

    expect(await screen.findByText(/Save failed: nope/i)).toBeInTheDocument();
    // The optimistic selection is rolled back to what the server still holds —
    // otherwise the row would claim a control method that was never saved.
    expect(methodSelect.value).toBe("open_close");
  });

  it("runs the vent close test from its box on the room card", async () => {
    vi.mocked(api.testVent).mockResolvedValue({ ok: true });
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    await openDevices("Smart Vents");
    fireEvent.click(await screen.findByText("Test close"));

    expect(api.testVent).toHaveBeenCalledWith("cover.vent", "open_close", "close");
    expect(await screen.findByText(/Close command accepted/i)).toBeInTheDocument();
  });

  it("adds a presence sensor from its box on the room card", async () => {
    vi.mocked(api.addPresence).mockResolvedValue({
      id: "p1",
      room_id: "room-1",
      entity_id: "binary_sensor.motion",
    });
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    await openDevices("Occupancy Sensors");
    const picker = await screen.findByPlaceholderText(/Search occupancy and motion sensors/i);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: "Motion" } });
    fireEvent.mouseDown(await screen.findByText("Motion"));

    await waitFor(() => {
      expect(api.addPresence).toHaveBeenCalledWith("room-1", "binary_sensor.motion");
    });
  });

  it("edits a room's name, sensor choice and notes in My Home", async () => {
    vi.mocked(api.updateRoom).mockResolvedValue(mockRooms[0]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Living Room" }));
    // How the room is heated and cooled is in Smart Control, not here.
    expect(screen.queryByLabelText(/Presence holdover/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Temperature offset/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Presence-triggered temperature/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Room name/i), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByLabelText(/Include the thermostat.s own sensor/i));
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(api.updateRoom).toHaveBeenCalledWith("room-1", {
        name: "Renamed",
        thermostat_entity_id: mockRooms[0].thermostat_entity_id,
        include_thermostat_sensor: true,
        notes: "hello",
      });
    });
  });

  it("edits how a room is heated and cooled in Smart Control, sending only that", async () => {
    vi.mocked(api.updateRoom).mockResolvedValue(mockRooms[0]);
    renderTuning();
    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));
    const dialog = screen.getByRole("dialog", { name: "Living Room heating and cooling" });
    expect(within(dialog).queryByLabelText(/Room name/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete Room" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Presence holdover/i), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText(/Temperature offset/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/Deadband override/i), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.updateRoom).mock.calls[0];
    expect(id).toBe("room-1");
    expect(body).toMatchObject({
      presence_holdover_hours: 3,
      temp_offset: 2,
      deadband_override: 1.5,
    });
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("system_wide_temp");
    // Saved: the dialog closes and the list is read again.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("sends null deadband_override when the field is left blank (inherit)", async () => {
    vi.mocked(api.updateRoom).mockResolvedValue(mockRooms[0]);
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <RoomsSection />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));

    // mockRooms[0] has no deadband_override → the field renders blank and the
    // payload carries null so the room keeps inheriting the thermostat deadband.
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(api.updateRoom).toHaveBeenCalledWith(
        "room-1",
        expect.objectContaining({ deadband_override: null })
      );
    });
  });

  it("clears an existing override back to null when the field is emptied", async () => {
    // The user's "changed my mind" flow: a room that already HAS an override,
    // opened on the settings page (field pre-populated), cleared, saved → null.
    const roomWithOverride = { ...mockRooms[0], deadband_override: 1.5 };
    vi.mocked(api.getRooms).mockResolvedValue([roomWithOverride]);
    vi.mocked(api.getRoom).mockResolvedValue(roomWithOverride);
    vi.mocked(api.updateRoom).mockResolvedValue(roomWithOverride);
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <RoomsSection />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));

    // Field initialises with the stored override (1.5°F → "1.5" in °F mode).
    const overrideInput = screen.getByLabelText(/Deadband override/i) as HTMLInputElement;
    expect(overrideInput.value).toBe("1.5");

    // Clear it and save — no validation error, payload carries null.
    fireEvent.change(overrideInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(api.updateRoom).toHaveBeenCalledWith(
        "room-1",
        expect.objectContaining({ deadband_override: null })
      );
    });
  });

  it("closes the settings page via Cancel without saving", async () => {
    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <Rooms />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit Living Room" }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText(/Room name/i)).not.toBeInTheDocument();
    });
    expect(api.updateRoom).not.toHaveBeenCalled();
  });
});

describe("Rooms Page — Celsius mode", () => {
  const renderInCelsius = () =>
    render(
      <UnitContext.Provider value={buildUnitContext("C")}>
        <SystemContext.Provider value={mockSystem}>
          <MemoryRouter>
            <Rooms />
          </MemoryRouter>
        </SystemContext.Provider>
      </UnitContext.Provider>
    );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getRooms).mockResolvedValue(mockRooms);
    vi.mocked(api.getThermostats).mockResolvedValue(mockThermostats);
    vi.mocked(api.getRoom).mockImplementation((id: string) =>
      Promise.resolve(mockRooms.find((r) => r.id === id) as api.Room)
    );
    vi.mocked(api.getRoomActiveStatuses).mockResolvedValue({
      "room-1": {
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
      },
    });
    vi.mocked(api.getEntityStates).mockResolvedValue({
      "sensor.temp": { state: "72.5", numeric: 72.5, unit: "°F", attributes: {} },
      "cover.vent": {
        state: "open",
        numeric: null,
        unit: "",
        attributes: { current_position: 100 },
      },
    });
    vi.mocked(api.getHAEntities).mockResolvedValue([]);
  });

  it("keeps a stored 10°F deadband editable in °C instead of wedging the room (#521)", async () => {
    // 10 °F is the documented maximum and the backend accepts it inclusively,
    // but toDisplayDelta(10) is 5.56, which converts back to 10.01 and is
    // refused. Unclamped, the field shows 5.56 in a control capped at 5.55 and
    // every save on the room is rejected — citing a field never touched.
    vi.mocked(api.getRooms).mockResolvedValue([{ ...mockRooms[0], deadband_override: 10 }]);
    vi.mocked(api.getRoom).mockResolvedValue({
      ...mockRooms[0],
      deadband_override: 10,
    } as api.Room);
    renderTuningInCelsius();
    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));

    const input = screen.getByLabelText(/Deadband override/i);
    expect(input).toHaveValue(5.55);
    expect(input).toHaveAttribute("max", "5.55");
  });

  it("displays live sensor avgTemp converted to °C on room card", async () => {
    // sensor.temp numeric=72.5°F → fmtTemp(72.5) in °C = "22.5°C"
    renderInCelsius();
    expect(await screen.findByText("22.5°C")).toBeInTheDocument();
  });

  it("shows the offset label in °C", async () => {
    renderTuningInCelsius();
    const editBtn = await screen.findByRole("button", { name: "Change Living Room" });
    fireEvent.click(editBtn);

    expect(screen.getByText(/Temperature offset \(°C\)/i)).toBeInTheDocument();
  });

  it("sends the user's raw °C deadband_override when updating room (#231)", async () => {
    vi.mocked(api.updateRoom).mockResolvedValue(mockRooms[0]);

    renderTuningInCelsius();
    const editBtn = await screen.findByRole("button", { name: "Change Living Room" });
    fireEvent.click(editBtn);

    // deadband_override is a delta: the frontend sends the display value as-is
    // and the backend's _delta_to_f converts °C → °F. Asserting the raw value
    // guards against the #231 double-conversion.
    fireEvent.change(screen.getByLabelText(/Deadband override/i), { target: { value: "1" } });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(api.updateRoom).toHaveBeenCalledWith(
        "room-1",
        expect.objectContaining({ deadband_override: 1 })
      );
    });
  });

  it("sends the user's raw °C eco override fields when updating room (#231, #417)", async () => {
    // eco_cooling_outdoor_threshold is absolute (would wrongly become 86°F if
    // pre-converted); eco_cooling_max_drift is a delta (would wrongly become
    // 3.6°F). Both must arrive as the raw °C number the user typed — the
    // backend's _to_f / _delta_to_f do the conversion at the write boundary.
    vi.mocked(api.updateRoom).mockResolvedValue(mockRooms[0]);

    renderTuningInCelsius();
    const editBtn = await screen.findByRole("button", { name: "Change Living Room" });
    fireEvent.click(editBtn);

    fireEvent.change(screen.getByLabelText(/Cooling.*outdoor threshold/i), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText(/Cooling.*max drift/i), {
      target: { value: "2" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(api.updateRoom).toHaveBeenCalled();
    });
    const [, payload] = vi.mocked(api.updateRoom).mock.calls[0];
    expect(payload.eco_cooling_outdoor_threshold).toBe(30);
    expect(payload.eco_cooling_outdoor_threshold).not.toBe(86);
    expect(payload.eco_cooling_max_drift).toBe(2);
    expect(payload.eco_cooling_max_drift).not.toBe(3.6);
  });

  it("sends the user's raw °C ambient-suppression fields when updating room (#231, #417)", async () => {
    // ambient_suppression_min_differential and ambient_suppression_deadband
    // are both deltas — a pre-converted °F payload would send 3.6 instead of
    // the raw 2 the user typed. The checkbox needs an outside sensor to enable.
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 80,
    });
    vi.mocked(api.updateRoom).mockResolvedValue(mockRooms[0]);

    renderTuningInCelsius();
    const editBtn = await screen.findByRole("button", { name: "Change Living Room" });
    fireEvent.click(editBtn);

    const ambientCheckbox = (await screen.findByLabelText(
      /Skip presence heating\/cooling/i
    )) as HTMLInputElement;
    await waitFor(() => expect(ambientCheckbox).not.toBeDisabled());
    fireEvent.click(ambientCheckbox);

    fireEvent.change(screen.getByLabelText(/Minimum outside difference \(°C\)/i), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText(/Widened deadband \(°C\)/i), {
      target: { value: "2" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(api.updateRoom).toHaveBeenCalled();
    });
    const [, payload] = vi.mocked(api.updateRoom).mock.calls[0];
    expect(payload.ambient_suppression_min_differential).toBe(2);
    expect(payload.ambient_suppression_min_differential).not.toBe(3.6);
    expect(payload.ambient_suppression_deadband).toBe(2);
    expect(payload.ambient_suppression_deadband).not.toBe(3.6);
  });
});

// ---------------------------------------------------------------------------
// Eco Mode per-room override (Issue #404)
// ---------------------------------------------------------------------------
describe("Rooms Page — Eco Mode override (#404)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getRooms).mockResolvedValue(mockRooms);
    vi.mocked(api.getThermostats).mockResolvedValue(mockThermostats);
    vi.mocked(api.getRoom).mockImplementation((id: string) =>
      Promise.resolve(mockRooms.find((r) => r.id === id) as api.Room)
    );
    vi.mocked(api.getRoomActiveStatuses).mockResolvedValue({
      "room-1": {
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
      },
    });
    vi.mocked(api.getEntityStates).mockResolvedValue({});
    vi.mocked(api.getHAEntities).mockResolvedValue([]);
    // Default: an outside sensor is configured so the "On" option is available.
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 80,
    });
  });

  it("initializes tri-state enable and per-field overrides from an existing room, then saves them", async () => {
    // A room that forces Eco on and overrides two fields (one absolute, one
    // delta). Exercises the eco state-init branches and the payload builder.
    const ecoRoom: api.Room = {
      ...mockRooms[0],
      eco_mode_enabled: true,
      eco_cooling_outdoor_threshold: 90,
      eco_cooling_max_drift: 6,
    };
    vi.mocked(api.getRooms).mockResolvedValue([ecoRoom]);
    vi.mocked(api.getRoom).mockResolvedValue(ecoRoom);
    vi.mocked(api.updateRoom).mockResolvedValue(ecoRoom);

    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <RoomsSection />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));

    // Tri-state enable initialised to "On for this room".
    const ecoSelect = screen.getByLabelText(/^Eco Mode$/) as HTMLSelectElement;
    expect(ecoSelect.value).toBe("on");

    // Wait for the outside-sensor probe to resolve so the save-time guard
    // (Eco on requires a sensor) does not block this legitimate save.
    const onOption = within(ecoSelect).getByRole("option", {
      name: /On for this room/i,
    }) as HTMLOptionElement;
    await waitFor(() => expect(onOption).not.toBeDisabled());

    // Per-field overrides initialised in display units (°F here).
    const threshInput = screen.getByLabelText(/Cooling.*outdoor threshold/i) as HTMLInputElement;
    expect(threshInput.value).toBe("90");
    const driftInput = screen.getByLabelText(/Cooling.*max drift/i) as HTMLInputElement;
    expect(driftInput.value).toBe("6");

    // Fields left blank inherit the thermostat — the placeholder echoes the
    // inherited value (heating threshold defaults to 40°F).
    const heatThresh = screen.getByLabelText(/Heating.*outdoor threshold/i) as HTMLInputElement;
    expect(heatThresh.value).toBe("");
    expect(heatThresh.placeholder).toMatch(/Inherit \(40°F\)/);

    // The worked example renders because a thermostat is selected.
    expect(screen.getByTestId("eco-worked-example")).toBeInTheDocument();

    // Edit an override field (covers the eco onChange handler).
    fireEvent.change(driftInput, { target: { value: "5" } });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => {
      expect(api.updateRoom).toHaveBeenCalledWith(
        "room-1",
        expect.objectContaining({
          eco_mode_enabled: true,
          eco_cooling_outdoor_threshold: 90,
          eco_cooling_max_drift: 5,
          // Untouched fields stay null (inherit the thermostat).
          eco_heating_outdoor_threshold: null,
        })
      );
    });
  });

  it("initializes to Off for a room that opts out, and saves the tri-state as false", async () => {
    const offRoom: api.Room = { ...mockRooms[0], eco_mode_enabled: false };
    vi.mocked(api.getRooms).mockResolvedValue([offRoom]);
    vi.mocked(api.getRoom).mockResolvedValue(offRoom);
    vi.mocked(api.updateRoom).mockResolvedValue(offRoom);

    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <RoomsSection />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));
    const ecoSelect = screen.getByLabelText(/^Eco Mode$/) as HTMLSelectElement;
    expect(ecoSelect.value).toBe("off");

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => {
      expect(api.updateRoom).toHaveBeenCalledWith(
        "room-1",
        expect.objectContaining({ eco_mode_enabled: false })
      );
    });
  });

  // The third leg of the tri-state, and the one that matters most: "inherit"
  // must POST `null`, not `false`. Both non-null values mean "this room has
  // decided for itself", so collapsing inherit to false silently opts every
  // room out of the thermostat's Eco toggle — and neither the "on" nor the
  // "off" case above can see it, since both assert a non-null value.
  it("saves the inherit tri-state as null rather than false (#404)", async () => {
    const inheritRoom: api.Room = { ...mockRooms[0], eco_mode_enabled: null };
    vi.mocked(api.getRooms).mockResolvedValue([inheritRoom]);
    vi.mocked(api.getRoom).mockResolvedValue(inheritRoom);
    vi.mocked(api.updateRoom).mockResolvedValue(inheritRoom);

    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <RoomsSection />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));
    const ecoSelect = screen.getByLabelText(/^Eco Mode$/) as HTMLSelectElement;
    expect(ecoSelect.value).toBe("inherit");

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => expect(api.updateRoom).toHaveBeenCalled());
    const [, payload] = vi.mocked(api.updateRoom).mock.calls[0];
    // Explicitly null — `toBeNull` rather than a falsy check, because `false`
    // is exactly the wrong value this guards against.
    expect(payload.eco_mode_enabled).toBeNull();
  });

  // Returning to inherit from an explicit choice is the path an operator takes
  // to hand a room back to the thermostat; it must clear to null too.
  it("clears an explicit Off back to null when switched to inherit (#404)", async () => {
    const offRoom: api.Room = { ...mockRooms[0], eco_mode_enabled: false };
    vi.mocked(api.getRooms).mockResolvedValue([offRoom]);
    vi.mocked(api.getRoom).mockResolvedValue(offRoom);
    vi.mocked(api.updateRoom).mockResolvedValue(offRoom);

    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <RoomsSection />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));
    const ecoSelect = screen.getByLabelText(/^Eco Mode$/) as HTMLSelectElement;
    expect(ecoSelect.value).toBe("off");
    fireEvent.change(ecoSelect, { target: { value: "inherit" } });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => expect(api.updateRoom).toHaveBeenCalled());
    const [, payload] = vi.mocked(api.updateRoom).mock.calls[0];
    expect(payload.eco_mode_enabled).toBeNull();
  });

  it("blocks forcing Eco on without an outside-temperature sensor and shows the hint", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: null,
      current_value: null,
    });
    renderTuning();
    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));

    // The gating hint is shown when no sensor is configured.
    expect(screen.getByText(/Eco Mode needs to know the outside temperature/)).toBeInTheDocument();

    // Force "on" (the option is disabled in the UI, but the save still guards).
    const ecoSelect = screen.getByLabelText(/^Eco Mode$/) as HTMLSelectElement;
    fireEvent.change(ecoSelect, { target: { value: "on" } });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    expect(await screen.findByText(/before forcing Eco on for this room/i)).toBeInTheDocument();
    expect(api.updateRoom).not.toHaveBeenCalled();
  });

  it("falls back to a neutral worked example when the thermostat carries no eco values", async () => {
    // A thermostat whose eco fields are all null: the inherited values resolve
    // to null so the placeholders read plain "Inherit" and the worked example
    // uses the 0 fallback rather than crashing.
    const bareThermo = {
      ...mockThermostats[0],
      thermostat_entity_id: "climate.bare",
      name: "Bare HVAC",
      eco_cooling_outdoor_threshold: null,
      eco_cooling_full_drift_temp: null,
      eco_cooling_max_drift: null,
      eco_heating_outdoor_threshold: null,
      eco_heating_full_drift_temp: null,
      eco_heating_max_drift: null,
      eco_hysteresis_band: null,
    } as unknown as api.ThermostatConfig;
    const bareRoom: api.Room = { ...mockRooms[0], thermostat_entity_id: "climate.bare" };
    vi.mocked(api.getThermostats).mockResolvedValue([bareThermo]);
    vi.mocked(api.getRooms).mockResolvedValue([bareRoom]);
    vi.mocked(api.getRoom).mockResolvedValue(bareRoom);

    render(
      <SystemContext.Provider value={mockSystem}>
        <MemoryRouter>
          <RoomsSection />
        </MemoryRouter>
      </SystemContext.Provider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Change Living Room" }));

    // Placeholder is a plain "Inherit" — no inherited value to echo.
    const threshInput = screen.getByLabelText(/Cooling.*outdoor threshold/i) as HTMLInputElement;
    expect(threshInput.placeholder).toBe("Inherit");

    // The worked example still renders (a thermostat is selected).
    expect(screen.getByTestId("eco-worked-example")).toBeInTheDocument();
  });
});
