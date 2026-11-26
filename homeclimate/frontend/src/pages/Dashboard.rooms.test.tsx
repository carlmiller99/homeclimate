/** Dashboard layout by building → zone → room, and the per-room controls. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import Dashboard from "./Dashboard";
import * as api from "../api";
import * as zonesApi from "../zonesApi";
import * as sc from "../smartControlApi";
import { UnitContext, buildUnitContext } from "../contexts";
import { FAN_DEFAULTS, HP_DEFAULTS, smartControl } from "../zoneFixtures";
import { makeHold } from "../testFixtures";

vi.mock("../api");
// The plan card loads by itself and has its own tests.
vi.mock("../components/TodayCard", () => ({ default: () => null }));
// The targets card has its own tests (Dashboard.house.test.tsx); here it never loads.
vi.mock("../houseApi", async (orig) => ({
  ...(await orig<typeof import("../houseApi")>()),
  getHouse: () => Promise.reject(new Error("house not loaded")),
}));
// Building modes have their own tests (Dashboard.buildings.test.tsx); here they never load.
vi.mock("../buildingModeApi", async (orig) => ({
  ...(await orig<typeof import("../buildingModeApi")>()),
  getBuildingModes: () => Promise.reject(new Error("building modes not loaded")),
}));
vi.mock("../smartControlApi", async (orig) => ({
  ...(await orig<typeof import("../smartControlApi")>()),
  getSmartControl: vi.fn(),
}));
vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getZones: vi.fn(),
  getBuildings: vi.fn(),
}));

const room = (id: string, name: string, thermostat_entity_id: string) =>
  ({ id, name, thermostat_entity_id }) as api.Room;

const status = (id: string, rooms: api.ZoneStatus["rooms"] = []): api.ZoneStatus => ({
  thermostat_entity_id: id,
  hvac_mode: "heat",
  hvac_action: "idle",
  current_temp: 68,
  setpoint: 70,
  cycle_state: "idle",
  cycle_id: null,
  cycle_started_at: null,
  rooms,
});

const profile = (
  id: string,
  name: string,
  building_id: string | null,
  sort_order = 0
): zonesApi.ZoneProfile => ({
  thermostat_entity_id: id,
  name,
  building_id,
  sort_order,
  system_type: "conventional",
  compressor_stages: 1,
  backup_heat: "electric",
  equipment_running_entity: null,
  heat_kit_confirmed: false,
  ...HP_DEFAULTS,
  ...FAN_DEFAULTS,
});

const thermostat = (id: string, name: string) =>
  ({ thermostat_entity_id: id, name }) as api.ThermostatConfig;

const reading = (numeric: number | null): api.EntityState => ({
  state: String(numeric),
  numeric,
  unit: "°F",
  attributes: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSensorHealth).mockResolvedValue({ stale_after_min: 30, rooms: [] });
  vi.mocked(api.getSensorStaleness).mockResolvedValue({ stale_after_min: 30 });
  vi.mocked(api.getThermostatHealth).mockResolvedValue({ thermostats: [] });
  vi.mocked(api.connectWS).mockReturnValue(() => {});
  vi.mocked(api.getVacationMode).mockResolvedValue({ enabled: false, return_at: null });
  vi.mocked(api.getOverrides).mockResolvedValue([]);
  vi.mocked(api.getStatus).mockResolvedValue([
    status("climate.up"),
    status("climate.den"),
    status("climate.north", [
      {
        room_id: "kitchen",
        avg_temp: 66,
        target_temp: 70,
        presence_active: true,
        vent_states: { "cover.kitchen": "open" },
      },
    ]),
  ]);
  vi.mocked(api.getRooms).mockResolvedValue([
    room("kitchen", "Kitchen", "climate.north"),
    room("mudroom", "Mudroom", "climate.north"),
    room("bunk", "Bunk Room", "climate.up"),
    room("loft", "Loft", "climate.den"),
  ]);
  vi.mocked(api.getThermostats).mockResolvedValue([
    thermostat("climate.north", "North Wing"),
    thermostat("climate.up", "Upstairs"),
    thermostat("climate.den", "Den"),
  ]);
  vi.mocked(api.getRoom).mockImplementation(
    async (id) =>
      ({
        id,
        sensors:
          id === "mudroom"
            ? [{ entity_id: "sensor.mud_a" }, { entity_id: "sensor.mud_b" }]
            : id === "bunk"
              ? [{ entity_id: "sensor.bunk" }]
              : [],
      }) as api.Room
  );
  vi.mocked(api.getEntityStates).mockResolvedValue({
    "sensor.mud_a": reading(64),
    "sensor.mud_b": reading(68),
    // A sensor that has not reported counts for nothing.
    "sensor.bunk": reading(null),
  });
  vi.mocked(sc.getSmartControl).mockResolvedValue(smartControl() as sc.SmartControl);
  vi.mocked(zonesApi.getBuildings).mockResolvedValue([
    { id: "b1", name: "Main House", sort_order: 0 },
    { id: "b2", name: "The Den", sort_order: 1 },
  ]);
  vi.mocked(zonesApi.getZones).mockResolvedValue([
    profile("climate.up", "Upstairs", "b1", 2),
    profile("climate.north", "North Wing", "b1", 1),
    profile("climate.den", "Den", "b2"),
  ]);
});

const building = (id: string) => screen.findByTestId(`dash-building-${id}`);

describe("Dashboard rooms and zones", () => {
  it("groups zones under their buildings, in zone order, with every room listed", async () => {
    const { container } = render(<Dashboard />);
    const main = await building("b1");
    expect(within(main).getByText("Main House")).toBeInTheDocument();
    // Zone order follows each zone's sort order, not the order of the status feed.
    const titles = [...main.querySelectorAll(".card-title")].map((t) => t.textContent);
    expect(titles).toEqual(["North Wing", "Upstairs"]);
    expect(within(main).getByTestId("dash-room-kitchen")).toBeInTheDocument();
    expect(within(main).getByTestId("dash-room-mudroom")).toBeInTheDocument();
    expect(within(main).getByTestId("dash-room-bunk")).toBeInTheDocument();
    expect(within(main).queryByTestId("dash-room-loft")).toBeNull();

    const den = await building("b2");
    expect(within(den).getByText("The Den")).toBeInTheDocument();
    expect(within(den).getByTestId("dash-room-loft")).toBeInTheDocument();
    expect(container.querySelectorAll(".dash-building")).toHaveLength(2);
  });

  it("shows an idle room's temperature from its own sensors", async () => {
    render(<Dashboard />);
    // Mean of the two mudroom sensors.
    await waitFor(() =>
      expect(screen.getByTestId("dash-room-mudroom")).toHaveTextContent("66.0°F")
    );
    // An active room shows the temperature the cycle is using.
    expect(screen.getByTestId("dash-room-kitchen")).toHaveTextContent("66.0°F");
    // What it asks for is in its details, not on the row.
    expect(screen.getByTestId("dash-room-kitchen")).not.toHaveTextContent("70.0°F");
    fireEvent.click(screen.getByTestId("dash-room-kitchen"));
    expect(screen.getByRole("dialog", { name: "Kitchen details" })).toHaveTextContent(
      "Asking for 70.0°F."
    );
    // No reading, and no sensors at all: a dash.
    expect(within(screen.getByTestId("dash-room-bunk")).getByText("—")).toBeInTheDocument();
    expect(within(screen.getByTestId("dash-room-loft")).getByText("—")).toBeInTheDocument();
    expect(api.getEntityStates).toHaveBeenCalledWith([
      "sensor.mud_a",
      "sensor.mud_b",
      "sensor.bunk",
    ]);
  });

  it("converts an idle room's temperature for display in Celsius", async () => {
    render(
      <UnitContext.Provider value={buildUnitContext("C")}>
        <Dashboard />
      </UnitContext.Provider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("dash-room-mudroom")).toHaveTextContent("18.9°C")
    );
  });

  it("reads each room's sensor list once, and the readings on every refresh", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(api.getEntityStates).toHaveBeenCalledTimes(1));
    expect(api.getRoom).toHaveBeenCalledTimes(4);

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(api.getEntityStates).toHaveBeenCalledTimes(2));
    expect(api.getRoom).toHaveBeenCalledTimes(4);

    // A new room changes the house's structure, so the lists are read again.
    vi.mocked(api.getRooms).mockResolvedValue([
      room("kitchen", "Kitchen", "climate.north"),
      room("pantry", "Pantry", "climate.north"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(api.getRoom).toHaveBeenCalledTimes(6));
    expect(await screen.findByTestId("dash-room-pantry")).toBeInTheDocument();
  });

  it("starts a hold from a room, preselecting that room", async () => {
    render(<Dashboard />);
    fireEvent.click(await screen.findByTestId("dash-room-mudroom"));
    fireEvent.click(screen.getByRole("button", { name: "Start a Hold" }));
    // The details hand over to the hold dialog.
    expect(screen.queryByRole("dialog", { name: "Mudroom details" })).toBeNull();
    expect(screen.getByTestId("hold-modal")).toBeInTheDocument();
    expect(screen.getByTestId("hold-modal").querySelector("#hold-room")).toHaveValue("mudroom");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("hold-modal")).toBeNull();
  });

  it("cancels a hold from the held room and reloads", async () => {
    vi.mocked(api.getOverrides).mockResolvedValue([makeHold({ room_id: "mudroom" })]);
    vi.mocked(api.clearOverride).mockResolvedValue(undefined as never);
    render(<Dashboard />);
    const mudroom = await screen.findByTestId("dash-room-mudroom");
    // A held room carries the badge even though it is not part of a running
    // cycle, and its details offer Cancel Hold in place of Start a Hold.
    expect(within(mudroom).getByTitle(/temporary hold is driving this room/i)).toBeInTheDocument();
    fireEvent.click(mudroom);
    expect(screen.queryByRole("button", { name: "Start a Hold" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel Hold" }));
    await waitFor(() => expect(api.clearOverride).toHaveBeenCalledWith("mudroom"));
    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2));
  });

  it("clears presence only on rooms that have it", async () => {
    vi.mocked(api.clearPresenceHoldover).mockResolvedValue(undefined as never);
    render(<Dashboard />);
    fireEvent.click(await screen.findByTestId("dash-room-mudroom"));
    expect(screen.queryByRole("button", { name: "Clear Presence" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByTestId("dash-room-kitchen"));
    fireEvent.click(screen.getByRole("button", { name: "Clear Presence" }));
    await waitFor(() => expect(api.clearPresenceHoldover).toHaveBeenCalledWith("kitchen"));
    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2));
  });

  it("lists a cycle room the room list does not know yet, by its id", async () => {
    vi.mocked(api.getStatus).mockResolvedValue([
      status("climate.north", [
        {
          room_id: "new-room",
          avg_temp: 61,
          target_temp: 70,
          presence_active: false,
          vent_states: {},
        },
      ]),
    ]);
    render(<Dashboard />);
    const row = await screen.findByTestId("dash-room-new-room");
    expect(row).toHaveTextContent("new-room");
    expect(row).toHaveTextContent("61.0°F");
  });

  it("puts zones with no (or an unknown) building under Other Zones", async () => {
    vi.mocked(zonesApi.getZones).mockResolvedValue([
      profile("climate.north", "North Wing", "b1"),
      profile("climate.up", "Upstairs", null),
      // climate.den has no profile at all.
    ]);
    render(<Dashboard />);
    const other = await building("unassigned");
    expect(within(other).getByText("Other Zones")).toBeInTheDocument();
    expect(within(other).getByTestId("dash-room-bunk")).toBeInTheDocument();
    expect(within(other).getByTestId("dash-room-loft")).toBeInTheDocument();
    // A building with no zones has nothing to show on the Dashboard.
    expect(screen.queryByTestId("dash-building-b2")).toBeNull();
    expect(screen.queryByText("The Den")).toBeNull();
  });

  it("falls back to a plain list of zones when the layout cannot be read", async () => {
    vi.mocked(zonesApi.getBuildings).mockRejectedValue(new Error("down"));
    vi.mocked(zonesApi.getZones).mockRejectedValue(new Error("down"));
    vi.mocked(api.getRoom).mockRejectedValue(new Error("down"));
    vi.mocked(api.getEntityStates).mockRejectedValue(new Error("down"));
    render(<Dashboard />);
    const group = await building("unassigned");
    // No buildings → no building heading at all.
    expect(within(group).queryByText("Other Zones")).toBeNull();
    expect(within(group).getByTestId("dash-room-kitchen")).toBeInTheDocument();
    expect(within(group).getByTestId("dash-room-loft")).toBeInTheDocument();
    // With no sensor lists there is nothing to read.
    expect(api.getEntityStates).not.toHaveBeenCalled();
  });

  it("shows dashes for idle rooms when the readings cannot be fetched", async () => {
    vi.mocked(api.getEntityStates).mockRejectedValue(new Error("down"));
    render(<Dashboard />);
    const mudroom = await screen.findByTestId("dash-room-mudroom");
    await waitFor(() => expect(api.getEntityStates).toHaveBeenCalled());
    expect(within(mudroom).getByText("—")).toBeInTheDocument();
  });

  it("shows the thermostat's own reading for a room that includes it", async () => {
    vi.mocked(api.getRooms).mockResolvedValue([
      { ...room("bunk", "Bunk Room", "climate.up"), include_thermostat_sensor: true },
      { ...room("mudroom", "Mudroom", "climate.north"), include_thermostat_sensor: true },
      { ...room("orphan", "Orphan", "climate.gone"), include_thermostat_sensor: true },
    ]);
    render(<Dashboard />);
    // Bunk Room's only sensor has not reported, so the thermostat's 68° stands alone.
    await waitFor(() => expect(screen.getByTestId("dash-room-bunk")).toHaveTextContent("68.0°F"));
    // Mudroom: 64, 68 and the thermostat's 68.
    expect(screen.getByTestId("dash-room-mudroom")).toHaveTextContent("66.7°F");
  });

  it("leaves stale sensors out of a room's temperature, as the engine does", async () => {
    vi.mocked(api.getSensorHealth).mockResolvedValue({
      stale_after_min: 30,
      rooms: [
        {
          room_id: "mudroom",
          room_name: "Mudroom",
          thermostat_entity_id: "climate.north",
          stale_sensors: [{ entity_id: "sensor.mud_a", age_seconds: 4000, reason: "stale" }],
        },
      ],
    });
    render(<Dashboard />);
    await waitFor(() =>
      expect(screen.getByTestId("dash-room-mudroom")).toHaveTextContent("68.0°F")
    );
  });

  it("still shows temperatures when sensor health and pauses cannot be read", async () => {
    vi.mocked(api.getSensorHealth).mockRejectedValue(new Error("down"));
    vi.mocked(sc.getSmartControl).mockRejectedValue(new Error("down"));
    render(<Dashboard />);
    await waitFor(() =>
      expect(screen.getByTestId("dash-room-mudroom")).toHaveTextContent("66.0°F")
    );
    expect(screen.queryByText(/Paused/)).toBeNull();
  });

  it("re-reads sensor lists after five minutes, and at once after a failed read", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    vi.mocked(api.getRoom).mockRejectedValueOnce(new Error("blip"));
    render(<Dashboard />);
    await waitFor(() => expect(api.getEntityStates).toHaveBeenCalledTimes(1));
    expect(api.getRoom).toHaveBeenCalledTimes(4);

    // One list could not be read, so the next refresh reads them all again.
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(api.getRoom).toHaveBeenCalledTimes(8));

    // Now complete: trusted until five minutes have passed.
    now.mockReturnValue(1_000_000 + 4 * 60_000);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(api.getEntityStates).toHaveBeenCalledTimes(3));
    expect(api.getRoom).toHaveBeenCalledTimes(8);

    // A sensor removed elsewhere is picked up once the list is read again.
    vi.mocked(api.getRoom).mockImplementation(
      async (id) => ({ id, sensors: [] }) as unknown as api.Room
    );
    now.mockReturnValue(1_000_000 + 6 * 60_000);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(api.getRoom).toHaveBeenCalledTimes(12));
    await waitFor(() =>
      expect(within(screen.getByTestId("dash-room-mudroom")).getByText("—")).toBeInTheDocument()
    );
    now.mockRestore();
  });

  it("says which door or window is pausing a zone or a room", async () => {
    const sensor = (over: Partial<sc.ContactSensor>): sc.ContactSensor => ({
      entity_id: "binary_sensor.x",
      name: "X",
      thermostat_entity_id: null,
      room_id: null,
      pauses: "room",
      state: "open",
      open_since: null,
      pausing: true,
      ...over,
    });
    vi.mocked(sc.getSmartControl).mockResolvedValue({
      ...smartControl([
        sensor({ name: "Mudroom Door", room_id: "mudroom", pauses: "zone" }),
        // A sensor attached to the zone itself, from before sensors moved into rooms.
        sensor({ name: "Side Door", thermostat_entity_id: "climate.north", pauses: "zone" }),
        sensor({ name: "Bunk Window", room_id: "bunk" }),
        // Open, but not (yet) pausing anything.
        sensor({ name: "Kitchen Door", room_id: "kitchen", pauses: "zone", pausing: false }),
        // Pausing another zone and another room.
        sensor({ name: "Loft Door", room_id: "loft", pauses: "zone" }),
      ]),
      paused: [
        { scope: "zone", scope_id: "climate.north", since: "2026-01-05T12:00:00Z" },
        { scope: "room", scope_id: "bunk", since: "2026-01-05T12:00:00Z" },
        // Paused with no sensor still reporting open (it is counting down to resume).
        { scope: "room", scope_id: "loft", since: "2026-01-05T12:00:00Z" },
      ],
    } as sc.SmartControl);
    render(<Dashboard />);

    const north = (await screen.findByTestId("dash-room-kitchen")).closest(".card") as HTMLElement;
    await waitFor(() =>
      expect(within(north).getByText("Paused: Mudroom Door, Side Door open")).toBeInTheDocument()
    );
    // The zone is paused, not its rooms individually.
    expect(within(screen.getByTestId("dash-room-kitchen")).queryByText("Paused")).toBeNull();

    const bunk = within(screen.getByTestId("dash-room-bunk")).getByText("Paused");
    expect(bunk).toHaveAttribute("title", "Paused: Bunk Window open");
    // Upstairs itself is not paused.
    const up = screen.getByTestId("dash-room-bunk").closest(".card") as HTMLElement;
    expect(within(up).queryByText(/^Paused:/)).toBeNull();

    const loft = within(screen.getByTestId("dash-room-loft")).getByText("Paused");
    expect(loft).toHaveAttribute("title", "Paused: door or window open");
  });

  it("marks a room whose call is waiting for it to coast to its target", async () => {
    vi.mocked(api.getStatus).mockResolvedValue([
      { ...status("climate.up"), coasting_rooms: ["bunk"] },
      {
        ...status("climate.den"),
        balance_rooms: ["loft"],
        bank_rooms: ["loft"],
        arrival_rooms: ["loft"],
        early_cool_rooms: ["loft"],
      },
      status("climate.north"),
    ]);
    render(<Dashboard />);
    const badge = await waitFor(() =>
      within(screen.getByTestId("dash-room-bunk")).getByText("Coasting")
    );
    expect(badge).toHaveAttribute(
      "title",
      expect.stringMatching(/expected to get there by itself/)
    );
    expect(within(screen.getByTestId("dash-room-kitchen")).queryByText("Coasting")).toBeNull();
    // And one being heated or cooled for Zone Balance.
    expect(within(screen.getByTestId("dash-room-loft")).getByText("Zone Balance")).toHaveAttribute(
      "title",
      expect.stringMatching(/within the gap limit of another/)
    );
    expect(within(screen.getByTestId("dash-room-bunk")).queryByText("Zone Balance")).toBeNull();
    // And one being banked ahead of the peak hours.
    expect(within(screen.getByTestId("dash-room-loft")).getByText("Banking")).toHaveAttribute(
      "title",
      expect.stringMatching(/less has to run during the peak hours/)
    );
    expect(within(screen.getByTestId("dash-room-bunk")).queryByText("Banking")).toBeNull();
    // And one being got ready for a usual arrival.
    expect(within(screen.getByTestId("dash-room-loft")).getByText("Getting Ready")).toHaveAttribute(
      "title",
      expect.stringMatching(/usually used about now/)
    );
    expect(within(screen.getByTestId("dash-room-bunk")).queryByText("Getting Ready")).toBeNull();
    // And one being cooled ahead of a warm afternoon.
    expect(within(screen.getByTestId("dash-room-loft")).getByText("Cooling Early")).toHaveAttribute(
      "title",
      expect.stringMatching(/expected to pass its Cool To later/)
    );
    expect(within(screen.getByTestId("dash-room-bunk")).queryByText("Cooling Early")).toBeNull();
  });

  it("marks a room a lit fireplace is keeping out of demand", async () => {
    vi.mocked(sc.getSmartControl).mockResolvedValue({
      ...smartControl([]),
      fireplace_rooms: [{ room_id: "kitchen", fireplace: "Hearth" }],
    } as sc.SmartControl);
    render(<Dashboard />);
    const badge = await waitFor(() =>
      within(screen.getByTestId("dash-room-kitchen")).getByText("Fireplace")
    );
    expect(badge).toHaveAttribute(
      "title",
      "Hearth is warming this room, so it isn't calling for heating or cooling"
    );
    expect(within(screen.getByTestId("dash-room-bunk")).queryByText("Fireplace")).toBeNull();
  });

  it("reports a hold that could not be cancelled, and presence that could not be cleared", async () => {
    vi.mocked(api.getOverrides).mockResolvedValue([makeHold({ room_id: "mudroom" })]);
    vi.mocked(api.clearOverride).mockRejectedValueOnce(new Error("Room not found"));
    render(<Dashboard />);
    const cancel = async () => {
      fireEvent.click(await screen.findByTestId("dash-room-mudroom"));
      fireEvent.click(screen.getByRole("button", { name: "Cancel Hold" }));
    };
    await cancel();
    expect(await screen.findByText("Room not found")).toBeInTheDocument();
    vi.mocked(api.clearOverride).mockRejectedValueOnce("x");
    await cancel();
    expect(await screen.findByText("Could not cancel the hold")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("dash-room-kitchen"));
    const clear = () => screen.getByRole("button", { name: "Clear Presence" });
    vi.mocked(api.clearPresenceHoldover).mockRejectedValueOnce(new Error("HA is unreachable"));
    fireEvent.click(clear());
    expect(await screen.findByText("HA is unreachable")).toBeInTheDocument();
    vi.mocked(api.clearPresenceHoldover).mockRejectedValueOnce(null);
    await waitFor(() => expect(clear()).toBeEnabled());
    fireEvent.click(clear());
    expect(await screen.findByText("Could not clear presence")).toBeInTheDocument();
  });

  it("offers Try Again when the first load fails, and keeps the page on a failed refresh", async () => {
    vi.mocked(api.getStatus).mockRejectedValueOnce(new Error("down"));
    render(<Dashboard />);
    expect(
      await screen.findByText("Could not load the dashboard. Check that HomeClimate is running.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByTestId("dash-room-kitchen")).toBeInTheDocument();

    vi.mocked(api.getStatus).mockRejectedValueOnce(new Error("blip"));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("dash-room-kitchen")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load the dashboard/)).toBeNull();
  });
});
