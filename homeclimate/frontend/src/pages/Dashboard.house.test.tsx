/** The Dashboard's targets card and each room's options. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import Dashboard from "./Dashboard";
import * as api from "../api";
import * as ha from "../houseApi";
import * as zonesApi from "../zonesApi";
import { SystemContext, UnitContext, buildUnitContext } from "../contexts";

vi.mock("../api");
// The plan card loads by itself and has its own tests.
vi.mock("../components/TodayCard", () => ({
  default: () => <div data-testid="today-card-stub" />,
}));
vi.mock("../houseApi", async (orig) => ({
  ...(await orig<typeof import("../houseApi")>()),
  getHouse: vi.fn(),
  setTargets: vi.fn(),
  setRoomSwitches: vi.fn(),
}));
// Building modes have their own tests (Dashboard.buildings.test.tsx); here they never load.
vi.mock("../buildingModeApi", async (orig) => ({
  ...(await orig<typeof import("../buildingModeApi")>()),
  getBuildingModes: () => Promise.reject(new Error("building modes not loaded")),
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

const ZONE = {
  thermostat_entity_id: "climate.main",
  name: "Main",
  building_id: null,
} as zonesApi.ZoneProfile;
const ZONE_TARGETS: ha.LevelTargets = {
  scope: "zone",
  scope_id: "climate.main",
  house_heat_to: 68,
  house_cool_to: 75.2,
};

function house(over: Partial<ha.House> = {}): ha.House {
  return {
    house_heat_to: null,
    house_cool_to: null,
    targets: [ZONE_TARGETS],
    min_gap: 0,
    low: 45,
    high: 95,
    rooms: [
      { room_id: "kitchen", in_use: true, use_schedules: true, use_presence: true },
      { room_id: "bunk", in_use: false, use_schedules: true, use_presence: true },
    ],
    ...over,
  };
}

const UNSET = house({ targets: [] });

/** The stored targets with one level set (or cleared, with two nulls). */
function withTargets(
  from: ha.LevelTargets[],
  scope: ha.TargetScope,
  id: string,
  h: number | null,
  c: number | null
) {
  const rest = from.filter((t) => !(t.scope === scope && t.scope_id === id));
  return h === null || c === null
    ? rest
    : [...rest, { scope, scope_id: id, house_heat_to: h, house_cool_to: c }];
}

function show(unit: "F" | "C" = "F") {
  return render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <Dashboard />
    </UnitContext.Provider>
  );
}

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
      thermostat_entity_id: "climate.main",
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
    { id: "kitchen", name: "Kitchen", thermostat_entity_id: "climate.main" },
    { id: "bunk", name: "Bunk Room", thermostat_entity_id: "climate.main" },
  ] as api.Room[]);
  vi.mocked(api.getThermostats).mockResolvedValue([
    { thermostat_entity_id: "climate.main", name: "Main" },
  ] as api.ThermostatConfig[]);
  vi.mocked(api.getRoom).mockResolvedValue({ sensors: [] } as unknown as Awaited<
    ReturnType<typeof api.getRoom>
  >);
  vi.mocked(api.getEntityStates).mockResolvedValue({});
  vi.mocked(ha.getHouse).mockResolvedValue(house());
  vi.mocked(zonesApi.getZones).mockResolvedValue([ZONE]);
  vi.mocked(zonesApi.getBuildings).mockResolvedValue([]);
  vi.mocked(ha.setTargets).mockImplementation(async (scope, id, h, c) =>
    house({ targets: withTargets([ZONE_TARGETS], scope, id, h, c) })
  );
  vi.mocked(ha.setRoomSwitches).mockImplementation(async (id, patch) =>
    house({
      rooms: house().rooms.map((r) => (r.room_id === id ? { ...r, ...patch } : r)),
    })
  );
});

const HEAT = "Heating Target for Main (°F)";
const COOL = "Cooling Target for Main (°F)";
const SAVE = "Save targets for Main";

describe("Dashboard targets", () => {
  it("shows a zone's targets and saves what was typed", async () => {
    show();
    const heat = await screen.findByLabelText(HEAT);
    // Today's Plan sits on the Dashboard too (it has its own tests).
    expect(screen.getByTestId("today-card-stub")).toBeInTheDocument();
    const cool = screen.getByLabelText(COOL);
    expect(heat).toHaveValue(68);
    expect(cool).toHaveValue(75.2);
    const save = screen.getByRole("button", { name: SAVE });
    expect(save).toBeDisabled(); // nothing changed yet
    fireEvent.change(heat, { target: { value: "66.5" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(ha.setTargets).toHaveBeenCalledWith("zone", "climate.main", 66.5, 75.2)
    );
    await waitFor(() => expect(screen.getByLabelText(HEAT)).toHaveValue(66.5));
    expect(screen.getByRole("button", { name: SAVE })).toBeDisabled();
  });

  it("sends Celsius as typed and never converts it", async () => {
    show("C");
    const heat = await screen.findByLabelText("Heating Target for Main (°C)");
    expect(heat).toHaveValue(20);
    expect(screen.getByLabelText("Cooling Target for Main (°C)")).toHaveValue(24);
    fireEvent.change(heat, { target: { value: "19" } });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));
    await waitFor(() => expect(ha.setTargets).toHaveBeenCalledWith("zone", "climate.main", 19, 24));
  });

  it("lets the two targets be the same, but not cross", async () => {
    vi.mocked(ha.getHouse).mockResolvedValue(UNSET);
    show();
    const heat = await screen.findByLabelText(HEAT);
    const save = screen.getByRole("button", { name: SAVE });
    expect(screen.getByText("No targets set")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear targets for Main" })).toBeNull();
    fireEvent.change(heat, { target: { value: "71" } });
    expect(save).toBeDisabled(); // needs both
    fireEvent.change(screen.getByLabelText(COOL), { target: { value: "70" } });
    expect(save).toBeDisabled();
    expect(
      screen.getByText("The cooling target cannot be below the heating target.")
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(COOL), { target: { value: "71" } });
    expect(screen.queryByText(/cannot be below/)).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(ha.setTargets).toHaveBeenCalledWith("zone", "climate.main", 71, 71));
  });

  it("asks before clearing targets that nothing above replaces", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Clear targets for Main" }));
    const dialog = screen.getByText("Clear these targets?").closest(".modal") as HTMLElement;
    expect(dialog).toHaveTextContent(/stop asking for heating or cooling straight away/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(ha.setTargets).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear targets for Main" }));
    fireEvent.click(
      within(screen.getByText("Clear these targets?").closest(".modal") as HTMLElement).getByRole(
        "button",
        { name: "Clear Targets" }
      )
    );
    await waitFor(() =>
      expect(ha.setTargets).toHaveBeenCalledWith("zone", "climate.main", null, null)
    );
    await waitFor(() => expect(screen.getByLabelText(HEAT)).toHaveValue(null));
  });

  it("gives a room its own targets, or lets it follow its zone", async () => {
    show();
    await screen.findByLabelText(HEAT);
    // A room's targets are in its details, which say what it follows.
    fireEvent.click(screen.getByRole("button", { name: "Details for Kitchen" }));
    const details = screen.getByRole("dialog", { name: "Kitchen details" });
    expect(details).toHaveTextContent("Main");
    const kitchen = within(details).getByRole("group", { name: "Kitchen" });
    expect(within(kitchen).getByText("Follows Main: 68 to 75.2°F")).toBeInTheDocument();
    const heat = within(kitchen).getByLabelText("Heating Target for Kitchen (°F)");
    expect(heat).toHaveAttribute("placeholder", "68");
    fireEvent.change(heat, { target: { value: "66" } });
    fireEvent.change(within(kitchen).getByLabelText("Cooling Target for Kitchen (°F)"), {
      target: { value: "66" },
    });
    vi.mocked(ha.setTargets).mockImplementation(async (scope, id, h, c) =>
      house({
        targets: withTargets(
          [
            ZONE_TARGETS,
            { scope: "room", scope_id: "kitchen", house_heat_to: 66, house_cool_to: 66 },
          ],
          scope,
          id,
          h,
          c
        ),
      })
    );
    fireEvent.click(within(kitchen).getByRole("button", { name: "Save targets for Kitchen" }));
    await waitFor(() => expect(ha.setTargets).toHaveBeenCalledWith("room", "kitchen", 66, 66));
    await waitFor(() => expect(within(kitchen).queryByText(/Follows Main/)).toBeNull());
    // Clearing a room's own targets hands it back to its zone, and says so.
    fireEvent.click(within(kitchen).getByRole("button", { name: "Clear targets for Kitchen" }));
    const dialog = screen.getByText("Clear these targets?").closest(".modal") as HTMLElement;
    expect(dialog).toHaveTextContent("This room goes back to following Main.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear Targets" }));
    await waitFor(() =>
      expect(ha.setTargets).toHaveBeenLastCalledWith("room", "kitchen", null, null)
    );
    expect(await within(kitchen).findByText("Follows Main: 68 to 75.2°F")).toBeInTheDocument();
  });

  it("puts a building first, with its zones and rooms under it", async () => {
    vi.mocked(zonesApi.getBuildings).mockResolvedValue([
      { id: "b1", name: "Main House", sort_order: 0 },
      { id: "b2", name: "Pool House", sort_order: 1 },
    ]);
    vi.mocked(zonesApi.getZones).mockResolvedValue([{ ...ZONE, building_id: "b1" }]);
    vi.mocked(ha.getHouse).mockResolvedValue(
      house({
        targets: [{ scope: "building", scope_id: "b1", house_heat_to: 71, house_cool_to: 72 }],
      })
    );
    show();
    expect(await screen.findByLabelText("Heating Target for Main House (°F)")).toHaveValue(71);
    expect(screen.getByText("Targets for zones in Main House")).toBeInTheDocument();
    // The zone follows its building, and the room follows through the zone.
    expect(
      within(screen.getByRole("group", { name: "Main" })).getByText(
        /^Follows Main House: 71 to 72°F$/
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details for Kitchen" }));
    const details = screen.getByRole("dialog", { name: "Kitchen details" });
    expect(details).toHaveTextContent("Main, Main House");
    expect(within(details).getByText("Follows Main House: 71 to 72°F")).toBeInTheDocument();
    fireEvent.click(within(details).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Kitchen details" })).toBeNull();
    // A building with no zones has nothing to show on the Dashboard.
    expect(screen.queryByLabelText("Heating Target for Pool House (°F)")).toBeNull();
    // With targets nowhere above it, a zone says where it looked.
    vi.mocked(ha.getHouse).mockResolvedValue(UNSET);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(
      await within(screen.getByRole("group", { name: "Main" })).findByText(
        "No targets set, here or for Main House"
      )
    ).toBeInTheDocument();
  });

  it("says what clearing a room's targets does when nothing above has any", async () => {
    vi.mocked(ha.getHouse).mockResolvedValue(
      house({
        targets: [{ scope: "room", scope_id: "kitchen", house_heat_to: 70, house_cool_to: 74 }],
      })
    );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Details for Kitchen" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear targets for Kitchen" }));
    expect(screen.getByText("Clear these targets?").closest(".modal")).toHaveTextContent(
      /^.*This room stops asking for heating or cooling straight away, unless a hold/
    );
  });

  it("notes targets close enough to heat and cool in turn", async () => {
    show();
    const cool = await screen.findByLabelText(COOL);
    expect(screen.queryByText(/With targets this close/)).toBeNull();
    fireEvent.change(cool, { target: { value: "69.5" } });
    expect(screen.getByText(/With targets this close/)).toBeInTheDocument();
    fireEvent.change(cool, { target: { value: "70" } });
    expect(screen.queryByText(/With targets this close/)).toBeNull();
  });

  it("leaves the targets card out when the home's layout could not be loaded", async () => {
    vi.mocked(zonesApi.getBuildings).mockRejectedValue(new Error("down"));
    show();
    await screen.findByRole("button", { name: "Details for Kitchen" });
    await waitFor(() => expect(ha.getHouse).toHaveBeenCalled());
    expect(screen.queryByText("Targets")).toBeNull();
    // It comes back with the layout.
    vi.mocked(zonesApi.getBuildings).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(await screen.findByLabelText(HEAT)).toHaveValue(68);
  });

  it("shows a room's reading, sensors and hold in its details", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Details for Kitchen" }));
    const details = screen.getByRole("dialog", { name: "Kitchen details" });
    expect(details).toHaveTextContent("Not asking for heating or cooling right now.");
    expect(details).toHaveTextContent(/No temperature sensors\. This room goes by its thermostat/);
    expect(details).toHaveTextContent(/A hold keeps this room at one temperature for 1 to 8 hours/);
    // Its two buttons hand over to the hold and the options dialogs.
    fireEvent.click(
      within(details).getByRole("button", { name: "In Use, Schedules and Occupancy" })
    );
    expect(screen.queryByRole("dialog", { name: "Kitchen details" })).toBeNull();
    expect(await screen.findByText(/Follow Its Schedules/)).toBeInTheDocument();
  });

  it("shows no targets card before there is anything to give targets to", async () => {
    vi.mocked(zonesApi.getZones).mockResolvedValue([]);
    show();
    await screen.findByTestId("today-card-stub");
    await waitFor(() => expect(ha.getHouse).toHaveBeenCalled());
    expect(screen.queryByText("Targets")).toBeNull();
  });

  it("shows why targets were refused and keeps what was typed", async () => {
    vi.mocked(ha.setTargets).mockRejectedValueOnce(new Error("Outside the safety limits"));
    show();
    const cool = await screen.findByLabelText(COOL);
    fireEvent.change(cool, { target: { value: "69" } });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));
    expect(await screen.findByText("Outside the safety limits")).toBeInTheDocument();
    expect(cool).toHaveValue(69);
    vi.mocked(ha.setTargets).mockRejectedValueOnce("nope");
    fireEvent.click(screen.getByRole("button", { name: SAVE }));
    expect(await screen.findByText("Could not save the targets")).toBeInTheDocument();
  });

  it("shows what was stored after a save that reads the same as before", async () => {
    show();
    const heat = await screen.findByLabelText(HEAT);
    fireEvent.change(heat, { target: { value: "68.0" } });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));
    await waitFor(() =>
      expect(ha.setTargets).toHaveBeenCalledWith("zone", "climate.main", 68, 75.2)
    );
    await waitFor(() => expect(screen.getByRole("button", { name: SAVE })).toBeDisabled());
  });

  it("keeps the targets and an unsaved edit when a refresh fails", async () => {
    show();
    const heat = await screen.findByLabelText(HEAT);
    fireEvent.change(heat, { target: { value: "65" } });
    vi.mocked(ha.getHouse).mockRejectedValueOnce(new Error("blip"));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(ha.getHouse).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText(HEAT)).toHaveValue(65);
    expect(screen.getByRole("button", { name: "Details for Kitchen" })).toBeInTheDocument();
  });

  it("shows targets that were changed somewhere else", async () => {
    show();
    await screen.findByLabelText(HEAT);
    vi.mocked(ha.getHouse).mockResolvedValue(
      house({ targets: [{ ...ZONE_TARGETS, house_heat_to: 64, house_cool_to: 70 }] })
    );
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(screen.getByLabelText(HEAT)).toHaveValue(64));
    expect(screen.getByLabelText(COOL)).toHaveValue(70);
  });

  it("keeps an unsaved edit when the dashboard refreshes with the same targets", async () => {
    show();
    const heat = await screen.findByLabelText(HEAT);
    fireEvent.change(heat, { target: { value: "65" } });
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(ha.getHouse).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText(HEAT)).toHaveValue(65);
  });
});

/** A room's options are reached through its details. */
function openOptions(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Details for ${name}` }));
  fireEvent.click(screen.getByRole("button", { name: "In Use, Schedules and Occupancy" }));
}

describe("Dashboard room options", () => {
  it("marks a room that is not in use and opens its options", async () => {
    show();
    const bunk = await screen.findByTestId("dash-room-bunk");
    expect(within(bunk).getByText("Not In Use")).toBeInTheDocument();
    const kitchen = screen.getByTestId("dash-room-kitchen");
    expect(within(kitchen).queryByText("Not In Use")).toBeNull();

    openOptions("Kitchen");
    const dialog = screen.getByRole("dialog", { name: "What Kitchen Follows" });
    const inUse = within(dialog).getByRole("switch", { name: "Room In Use" });
    expect(inUse).toBeChecked();
    expect(within(dialog).getByText("The room is heated and cooled as usual.")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("switch", { name: "Follow Its Schedules" }));
    await waitFor(() =>
      expect(ha.setRoomSwitches).toHaveBeenCalledWith("kitchen", { use_schedules: false })
    );
    expect(
      await within(dialog).findByText(
        "The room's schedules are skipped, not deleted. It follows its targets instead."
      )
    ).toBeInTheDocument();

    fireEvent.click(inUse);
    await waitFor(() =>
      expect(ha.setRoomSwitches).toHaveBeenLastCalledWith("kitchen", { in_use: false })
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("greys out the other switches for a room that is not in use", async () => {
    show();
    await screen.findByTestId("dash-room-bunk");
    openOptions("Bunk Room");
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("switch", { name: "Room In Use" })).not.toBeChecked();
    expect(within(dialog).getByText(/asks for no heating or cooling/)).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "Follow Occupancy" })).toBeDisabled();
    expect(within(dialog).getAllByText("Not used while the room is not in use.")).toHaveLength(2);
    // Clicking the backdrop closes it; clicking inside does not.
    fireEvent.click(dialog);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows that a room's In Use is set by a calendar and cannot be flipped here", async () => {
    vi.mocked(ha.getHouse).mockResolvedValue(
      house({
        rooms: [
          {
            room_id: "kitchen",
            in_use: true,
            use_schedules: true,
            use_presence: true,
            calendar: { entity_id: "calendar.custody", match_text: "", lead_min: 120 },
          },
        ],
      })
    );
    show();
    await screen.findByTestId("dash-room-kitchen");
    openOptions("Kitchen");
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("switch", { name: "Room In Use" })).toBeDisabled();
    expect(
      within(dialog).getByText(/Set by calendar\.custody; change it in Smart Control, Schedules\./)
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "Follow Occupancy" })).not.toBeDisabled();
  });

  it("reports a switch that could not be saved", async () => {
    vi.mocked(ha.setRoomSwitches).mockRejectedValueOnce(new Error("Room not found"));
    show();
    await screen.findByTestId("dash-room-kitchen");
    openOptions("Kitchen");
    fireEvent.click(screen.getByRole("switch", { name: "Follow Occupancy" }));
    expect(await screen.findByText("Room not found")).toBeInTheDocument();
    vi.mocked(ha.setRoomSwitches).mockRejectedValueOnce("nope");
    fireEvent.click(screen.getByRole("switch", { name: "Follow Occupancy" }));
    expect(await screen.findByText("Could not save the change")).toBeInTheDocument();
    expect(
      screen.getByText("When someone is in the room it gets its occupied target.")
    ).toBeInTheDocument();
  });

  it("has no house controls when the house could not be loaded", async () => {
    vi.mocked(ha.getHouse).mockRejectedValue(new Error("down"));
    show();
    await screen.findByTestId("dash-room-kitchen");
    expect(screen.queryByLabelText("Heat To (°F)")).toBeNull();
    // The room still opens, for a hold; it has no targets or options to offer.
    fireEvent.click(screen.getByRole("button", { name: "Details for Kitchen" }));
    expect(screen.getByRole("button", { name: "Start a Hold" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Targets" })).toBeNull();
    expect(screen.queryByRole("button", { name: "In Use, Schedules and Occupancy" })).toBeNull();
  });
});

describe("Dashboard system switch", () => {
  it("turns the whole system off and on, asking first", async () => {
    const toggle = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <SystemContext.Provider value={{ enabled: true, toggle }}>
        <Dashboard />
      </SystemContext.Provider>
    );
    const sw = await screen.findByRole("switch", { name: "System On" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(screen.getByText("Turn the system off?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(toggle).not.toHaveBeenCalled();
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole("button", { name: "Turn System Off" }));
    expect(toggle).toHaveBeenCalledTimes(1);
    view.unmount();

    render(
      <SystemContext.Provider value={{ enabled: false, toggle }}>
        <Dashboard />
      </SystemContext.Provider>
    );
    const off = await screen.findByRole("switch", { name: "System Off" });
    expect(off).toHaveAttribute("aria-checked", "false");
    fireEvent.click(off);
    expect(screen.getByText("Turn the system on?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn System On" }));
    expect(toggle).toHaveBeenCalledTimes(2);
  });
});
