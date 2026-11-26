import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import RoomsSection from "./RoomsSection";
import * as api from "../api";
import { buildUnitContext, UnitContext } from "../contexts";
import { ecoRoomDefaults, ecoThermostatDefaults } from "../testFixtures";

vi.mock("../api");

const room = (over: Partial<api.Room> = {}): api.Room =>
  ({
    id: "bunk",
    name: "Bunk Room",
    thermostat_entity_id: "climate.north",
    presence_holdover_hours: 2,
    include_thermostat_sensor: false,
    temp_offset: 0,
    deadband_override: null,
    system_wide_temp: null,
    notes: "",
    ambient_suppression_enabled: false,
    ambient_suppression_mode: "any_presence",
    ambient_suppression_min_differential: 5,
    ambient_suppression_deadband: 2,
    ambient_suppression_off_schedule_window_min: 60,
    ...ecoRoomDefaults,
    sensors: [],
    vents: [],
    presence_sensors: [],
    ...over,
  }) as api.Room;

const zone = (id: string, name: string) =>
  ({
    thermostat_entity_id: id,
    name,
    deadband: 0.5,
    ...ecoThermostatDefaults,
  }) as api.ThermostatConfig;

const show = (unit: "F" | "C" = "F") =>
  render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <RoomsSection />
    </UnitContext.Provider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getOutsideTempEntity).mockResolvedValue({ entity_id: null, current_value: null });
  vi.mocked(api.getThermostats).mockResolvedValue([zone("climate.north", "North Wing")]);
  vi.mocked(api.getRooms).mockResolvedValue([room()]);
});

describe("Smart Control → Rooms", () => {
  it("lists each zone's rooms with what they changed from the zone", async () => {
    vi.mocked(api.getRooms).mockResolvedValue([
      room(),
      room({
        id: "den",
        name: "Den",
        temp_offset: -3,
        deadband_override: 1,
        ambient_suppression_enabled: true,
        eco_mode_enabled: true,
      }),
      room({
        id: "loft",
        name: "Loft",
        thermostat_entity_id: "climate.gone",
        eco_mode_enabled: false,
      }),
    ]);
    show();
    expect(screen.getByText("Loading the rooms…")).toBeInTheDocument();
    const north = await screen.findByRole("group", { name: "North Wing" });
    const rows = within(north).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Bunk Room");
    expect(rows[0]).toHaveTextContent("Uses its zone's settings");
    expect(rows[1]).toHaveTextContent(
      "offset -3°F, own deadband 1°F, waits on the weather, Eco on"
    );
    // A zone whose thermostat is not listed goes by its id.
    const gone = screen.getByRole("group", { name: "climate.gone" });
    expect(within(gone).getByRole("listitem")).toHaveTextContent("Eco off");
  });

  it("shows differences in the house's unit", async () => {
    vi.mocked(api.getRooms).mockResolvedValue([room({ temp_offset: 1.8 })]);
    show("C");
    expect(await screen.findByText("offset 1°C")).toBeInTheDocument();
  });

  it("opens a room, and reads the list again once it is saved", async () => {
    vi.mocked(api.updateRoom).mockResolvedValue(room({ temp_offset: 2 }));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Change Bunk Room" }));
    const dialog = screen.getByRole("dialog", { name: "Bunk Room heating and cooling" });
    expect(within(dialog).getByText("Bunk Room: Heating and Cooling")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.getRooms).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Change Bunk Room" }));
    fireEvent.change(screen.getByLabelText(/Temperature offset/i), { target: { value: "2" } });
    // The reload after the save fails: the list stays, showing what was saved.
    vi.mocked(api.getRooms).mockRejectedValue(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("offset 2°F")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.getRooms).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Could not load the rooms.")).not.toBeInTheDocument();
    // Opening it again starts from what was saved.
    fireEvent.click(screen.getByRole("button", { name: "Change Bunk Room" }));
    expect(screen.getByLabelText(/Temperature offset/i)).toHaveValue(2);
  });

  it("says so with no rooms, and when it cannot load", async () => {
    vi.mocked(api.getRooms).mockResolvedValue([]);
    const first = show();
    expect(await screen.findByText("No rooms yet. Add one in My Home.")).toBeInTheDocument();
    first.unmount();
    vi.mocked(api.getRooms).mockRejectedValue(new Error("offline"));
    show();
    await waitFor(() => expect(screen.getByText("Could not load the rooms.")).toBeInTheDocument());
  });
});
