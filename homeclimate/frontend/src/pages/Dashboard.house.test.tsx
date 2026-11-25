/** The Dashboard's house band card and each room's options. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import Dashboard from "./Dashboard";
import * as api from "../api";
import * as ha from "../houseApi";
import { SystemContext, UnitContext, buildUnitContext } from "../contexts";

vi.mock("../api");
vi.mock("../houseApi", async (orig) => ({
  ...(await orig<typeof import("../houseApi")>()),
  getHouse: vi.fn(),
  setHouseBand: vi.fn(),
  setRoomSwitches: vi.fn(),
}));
vi.mock("../smartControlApi", async (orig) => ({
  ...(await orig<typeof import("../smartControlApi")>()),
  getSmartControl: () => Promise.reject(new Error("not needed")),
}));
vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getZones: () => Promise.resolve([]),
  getBuildings: () => Promise.resolve([]),
}));

function house(over: Partial<ha.House> = {}): ha.House {
  return {
    house_heat_to: 68,
    house_cool_to: 75.2,
    min_gap: 3,
    low: 45,
    high: 95,
    rooms: [
      { room_id: "kitchen", in_use: true, use_schedules: true, use_presence: true },
      { room_id: "bunk", in_use: false, use_schedules: true, use_presence: true },
    ],
    ...over,
  };
}

const UNSET = house({ house_heat_to: null, house_cool_to: null });

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
  vi.mocked(ha.setHouseBand).mockImplementation(async (h, c) =>
    house({ house_heat_to: h, house_cool_to: c })
  );
  vi.mocked(ha.setRoomSwitches).mockImplementation(async (id, patch) =>
    house({
      rooms: house().rooms.map((r) => (r.room_id === id ? { ...r, ...patch } : r)),
    })
  );
});

describe("Dashboard house band", () => {
  it("shows the band and saves what was typed", async () => {
    show();
    const heat = await screen.findByLabelText("Heat To (°F)");
    const cool = screen.getByLabelText("Cool To (°F)");
    expect(heat).toHaveValue(68);
    expect(cool).toHaveValue(75.2);
    expect(
      screen.getByText(/Every room is kept between these two temperatures/)
    ).toBeInTheDocument();
    expect(screen.getByText("Cool To must be at least 3° above Heat To.")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled(); // nothing changed yet
    fireEvent.change(heat, { target: { value: "66.5" } });
    fireEvent.click(save);
    await waitFor(() => expect(ha.setHouseBand).toHaveBeenCalledWith(66.5, 75.2));
    await waitFor(() => expect(screen.getByLabelText("Heat To (°F)")).toHaveValue(66.5));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("sends Celsius as typed and never converts it", async () => {
    show("C");
    const heat = await screen.findByLabelText("Heat To (°C)");
    expect(heat).toHaveValue(20);
    expect(screen.getByLabelText("Cool To (°C)")).toHaveValue(24);
    expect(screen.getByText("Cool To must be at least 1.67° above Heat To.")).toBeInTheDocument();
    fireEvent.change(heat, { target: { value: "19" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ha.setHouseBand).toHaveBeenCalledWith(19, 24));
  });

  it("offers to set a band when there is none, and to turn one off", async () => {
    vi.mocked(ha.getHouse).mockResolvedValue(UNSET);
    show();
    const set = await screen.findByRole("button", { name: "Set House Band" });
    expect(screen.getByText(/Without one, a room is only heated or cooled by/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn Off" })).toBeNull();
    expect(set).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Heat To (°F)"), { target: { value: "68" } });
    expect(set).toBeDisabled(); // needs both
    fireEvent.change(screen.getByLabelText("Cool To (°F)"), { target: { value: "74" } });
    fireEvent.click(set);
    await waitFor(() => expect(ha.setHouseBand).toHaveBeenCalledWith(68, 74));
    // Turning it off ends cycles, so it asks first.
    fireEvent.click(await screen.findByRole("button", { name: "Turn Off" }));
    expect(screen.getByText("Turn off the house band?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ha.setHouseBand).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Turn Off" }));
    const dialog = screen.getByText("Turn off the house band?").closest(".modal") as HTMLElement;
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn Off" }));
    await waitFor(() => expect(ha.setHouseBand).toHaveBeenLastCalledWith(null, null));
    expect(await screen.findByRole("button", { name: "Set House Band" })).toBeInTheDocument();
  });

  it("shows why a band was refused and keeps what was typed", async () => {
    vi.mocked(ha.setHouseBand).mockRejectedValueOnce(new Error("At least 3.0° apart"));
    show();
    const cool = await screen.findByLabelText("Cool To (°F)");
    fireEvent.change(cool, { target: { value: "69" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("At least 3.0° apart")).toBeInTheDocument();
    expect(cool).toHaveValue(69);
    vi.mocked(ha.setHouseBand).mockRejectedValueOnce("nope");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save the house band")).toBeInTheDocument();
  });

  it("shows what was stored after a save that reads the same as before", async () => {
    vi.mocked(ha.setHouseBand).mockResolvedValue(house());
    show();
    const heat = await screen.findByLabelText("Heat To (°F)");
    fireEvent.change(heat, { target: { value: "68.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ha.setHouseBand).toHaveBeenCalledWith(68, 75.2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });

  it("keeps the band and an unsaved edit when a refresh fails", async () => {
    show();
    const heat = await screen.findByLabelText("Heat To (°F)");
    fireEvent.change(heat, { target: { value: "65" } });
    vi.mocked(ha.getHouse).mockRejectedValueOnce(new Error("blip"));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(ha.getHouse).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Heat To (°F)")).toHaveValue(65);
    expect(screen.getByRole("button", { name: "Options for Kitchen" })).toBeInTheDocument();
  });

  it("shows a band that was changed somewhere else", async () => {
    show();
    await screen.findByLabelText("Heat To (°F)");
    vi.mocked(ha.getHouse).mockResolvedValue(house({ house_heat_to: 64, house_cool_to: 70 }));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(screen.getByLabelText("Heat To (°F)")).toHaveValue(64));
    expect(screen.getByLabelText("Cool To (°F)")).toHaveValue(70);
  });

  it("keeps an unsaved edit when the dashboard refreshes with the same band", async () => {
    show();
    const heat = await screen.findByLabelText("Heat To (°F)");
    fireEvent.change(heat, { target: { value: "65" } });
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(ha.getHouse).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Heat To (°F)")).toHaveValue(65);
  });
});

describe("Dashboard room options", () => {
  it("marks a room that is not in use and opens its options", async () => {
    show();
    const bunk = await screen.findByTestId("dash-room-bunk");
    expect(within(bunk).getByText("Not In Use")).toBeInTheDocument();
    const kitchen = screen.getByTestId("dash-room-kitchen");
    expect(within(kitchen).queryByText("Not In Use")).toBeNull();

    fireEvent.click(within(kitchen).getByRole("button", { name: "Options for Kitchen" }));
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
        "The room's schedules are skipped, not deleted. It follows the house band instead."
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
    const bunk = await screen.findByTestId("dash-room-bunk");
    fireEvent.click(within(bunk).getByRole("button", { name: "Options for Bunk Room" }));
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
    const kitchen = await screen.findByTestId("dash-room-kitchen");
    fireEvent.click(within(kitchen).getByRole("button", { name: "Options for Kitchen" }));
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
    const kitchen = await screen.findByTestId("dash-room-kitchen");
    fireEvent.click(within(kitchen).getByRole("button", { name: "Options for Kitchen" }));
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
    expect(screen.queryByRole("button", { name: "Options for Kitchen" })).toBeNull();
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
