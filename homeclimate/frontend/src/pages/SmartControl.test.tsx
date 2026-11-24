import { HP_DEFAULTS } from "../zoneFixtures";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import * as sc from "../smartControlApi";
import * as zonesApi from "../zonesApi";
import SmartControl from "./SmartControl";

vi.mock("../smartControlApi", async (orig) => ({
  ...(await orig<typeof import("../smartControlApi")>()),
  getSmartControl: vi.fn(),
  updateOpeningSettings: vi.fn(),
  setOpeningOverride: vi.fn(),
  saveContactSensor: vi.fn(),
  deleteContactSensor: vi.fn(),
}));
vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getZones: vi.fn(),
  getBuildings: vi.fn(),
}));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  getRooms: vi.fn(),
  getHAEntities: vi.fn(),
}));

const NOW = Date.parse("2026-01-05T12:10:00Z");

const zone = (id: string, name: string, building_id: string | null = null) => ({
  thermostat_entity_id: id,
  name,
  building_id,
  sort_order: 0,
  system_type: "conventional" as const,
  compressor_stages: 1,
  backup_heat: "electric" as const,
  equipment_running_entity: null,
  heat_kit_confirmed: false,
  ...HP_DEFAULTS,
});

const room = (id: string, name: string, thermostat_entity_id: string) =>
  ({ id, name, thermostat_entity_id }) as api.Room;

function data(overrides: Partial<sc.SmartControl> = {}): sc.SmartControl {
  return {
    settings: {
      zone_pause_enabled: true,
      zone_pause_min: 3,
      room_pause_enabled: true,
      room_pause_min: 5,
      resume_min: 2,
    },
    overrides: [],
    sensors: [
      {
        entity_id: "binary_sensor.front_door",
        name: "Front Door",
        thermostat_entity_id: "climate.north",
        room_id: null,
        state: "open",
        open_since: "2026-01-05T12:04:00Z",
        pausing: true,
      },
      {
        entity_id: "binary_sensor.porch_door",
        name: "Porch Door",
        thermostat_entity_id: null,
        room_id: "r1",
        state: "closed",
        open_since: null,
        pausing: false,
      },
      {
        entity_id: "binary_sensor.bunk_window",
        name: "Bunk Window",
        thermostat_entity_id: null,
        room_id: "r3",
        state: "offline",
        open_since: null,
        pausing: false,
      },
    ],
    paused: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.mocked(sc.getSmartControl).mockResolvedValue(data());
  vi.mocked(zonesApi.getZones).mockResolvedValue([
    zone("climate.north", "North Wing", "b1"),
    zone("climate.up", "Upstairs"),
    zone("climate.empty", ""),
  ]);
  vi.mocked(zonesApi.getBuildings).mockResolvedValue([
    { id: "b1", name: "Main House", sort_order: 0 },
  ]);
  vi.mocked(api.getRooms).mockResolvedValue([
    room("r1", "Kitchen", "climate.north"),
    room("r2", "Great Room", "climate.north"),
    room("r3", "Bunk Room", "climate.up"),
  ]);
  vi.mocked(api.getHAEntities).mockResolvedValue([
    { entity_id: "binary_sensor.side_door", friendly_name: "Side Door" } as api.HAEntity,
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function ready() {
  render(<SmartControl />);
  await screen.findByText("Front Door");
}

describe("Smart Control", () => {
  it("shows a loading line, then the rules, planned sections and sensors", async () => {
    render(<SmartControl />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await screen.findByText("Front Door");
    for (const name of sc.PLANNED_SECTIONS) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getByText(sc.OPENINGS_NOTE)).toBeInTheDocument();
    expect(screen.getByText("Open 6 Min, Pausing")).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Main House, climate.north")).toBeInTheDocument();
    expect(screen.getByText("climate.up")).toBeInTheDocument();
    expect(screen.getByLabelText("What Porch Door pauses")).toHaveValue("room:r1");
    expect(screen.getByLabelText("What Front Door pauses")).toHaveValue("zone:climate.north");
    expect(screen.getAllByText("Uses Defaults")).toHaveLength(2);
  });

  it("reports a failed load", async () => {
    vi.mocked(sc.getSmartControl).mockRejectedValueOnce(new Error("down"));
    render(<SmartControl />);
    expect(
      await screen.findByText("Could not load Smart Control. Check that HomeClimate is running.")
    ).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    vi.mocked(sc.getSmartControl).mockResolvedValue(data({ sensors: [] }));
    render(<SmartControl />);
    expect(await screen.findByText(/No doors or windows yet/)).toBeInTheDocument();
  });

  it("saves house-wide toggles and minutes", async () => {
    vi.mocked(sc.updateOpeningSettings).mockImplementation(async (patch) =>
      data({ settings: { ...data().settings, ...patch } })
    );
    await ready();
    fireEvent.click(screen.getByLabelText("Pause Zone When a Door or Window Is Open For"));
    await waitFor(() =>
      expect(sc.updateOpeningSettings).toHaveBeenCalledWith({ zone_pause_enabled: false })
    );
    expect(await screen.findByLabelText("Zone pause delay in minutes")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Pause Room When a Door or Window Is Open For"));
    await waitFor(() =>
      expect(sc.updateOpeningSettings).toHaveBeenCalledWith({ room_pause_enabled: false })
    );

    const resume = screen.getByLabelText("Resume delay in minutes");
    fireEvent.change(resume, { target: { value: "7" } });
    fireEvent.keyDown(resume, { key: "Enter" });
    await waitFor(() => expect(sc.updateOpeningSettings).toHaveBeenCalledWith({ resume_min: 7 }));
    await waitFor(() => expect(resume).toHaveValue(7));

    // Out of range, blank, fractional, unchanged, or other keys: no save, value restored.
    vi.mocked(sc.updateOpeningSettings).mockClear();
    for (const v of ["99", "", "2.5", "7"]) {
      fireEvent.change(resume, { target: { value: v } });
      fireEvent.blur(resume);
    }
    fireEvent.keyDown(resume, { key: "Tab" });
    expect(sc.updateOpeningSettings).not.toHaveBeenCalled();
    expect(resume).toHaveValue(7);

    const zoneMin = screen.getByLabelText("Room pause delay in minutes");
    vi.mocked(sc.updateOpeningSettings).mockResolvedValueOnce(data());
    fireEvent.change(screen.getByLabelText("Zone pause delay in minutes"), {
      target: { value: "4" },
    });
    fireEvent.blur(screen.getByLabelText("Zone pause delay in minutes"));
    await waitFor(() =>
      expect(sc.updateOpeningSettings).toHaveBeenCalledWith({ zone_pause_min: 4 })
    );
    fireEvent.change(zoneMin, { target: { value: "8" } });
    fireEvent.blur(zoneMin);
    await waitFor(() =>
      expect(sc.updateOpeningSettings).toHaveBeenCalledWith({ room_pause_min: 8 })
    );
  });

  it("shows a save error", async () => {
    await ready();
    vi.mocked(sc.updateOpeningSettings).mockRejectedValueOnce(new Error("resume_min is wrong"));
    fireEvent.click(screen.getByLabelText("Pause Zone When a Door or Window Is Open For"));
    expect(await screen.findByText("resume_min is wrong")).toBeInTheDocument();
    vi.mocked(sc.updateOpeningSettings).mockRejectedValueOnce("x");
    fireEvent.click(screen.getByLabelText("Pause Zone When a Door or Window Is Open For"));
    expect(await screen.findByText("Could not save the setting")).toBeInTheDocument();
  });

  it("adds a door or window", async () => {
    vi.mocked(sc.saveContactSensor).mockResolvedValue(data());
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Add Door or Window" }));
    const group = screen.getByRole("group", { name: "Add Door or Window" });
    const add = within(group).getByRole("button", { name: "Add Sensor" });
    expect(add).toBeDisabled();
    fireEvent.focus(within(group).getByPlaceholderText("Search doors and windows…"));
    fireEvent.mouseDown(await within(group).findByText("Side Door"));
    expect(within(group).getByText("binary_sensor.side_door")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "Change" }));
    fireEvent.focus(within(group).getByPlaceholderText("Search doors and windows…"));
    fireEvent.mouseDown(await within(group).findByText("Side Door"));
    fireEvent.change(within(group).getByRole("combobox"), {
      target: { value: "room:r2" },
    });
    fireEvent.click(add);
    await waitFor(() =>
      expect(sc.saveContactSensor).toHaveBeenCalledWith("binary_sensor.side_door", {
        room_id: "r2",
      })
    );
    expect(screen.queryByRole("group", { name: "Add Door or Window" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add Door or Window" }));
    const again = screen.getByRole("group", { name: "Add Door or Window" });
    fireEvent.focus(within(again).getByPlaceholderText("Search doors and windows…"));
    fireEvent.mouseDown(await within(again).findByText("Side Door"));
    fireEvent.change(within(again).getByRole("combobox"), {
      target: { value: "zone:climate.up" },
    });
    vi.mocked(sc.saveContactSensor).mockRejectedValueOnce(new Error("Choose a door"));
    fireEvent.click(within(again).getByRole("button", { name: "Add Sensor" }));
    expect(await within(again).findByText("Choose a door")).toBeInTheDocument();
    expect(sc.saveContactSensor).toHaveBeenLastCalledWith("binary_sensor.side_door", {
      thermostat_entity_id: "climate.up",
    });
    vi.mocked(sc.saveContactSensor).mockRejectedValueOnce(1);
    fireEvent.click(within(again).getByRole("button", { name: "Add Sensor" }));
    expect(await within(again).findByText("Could not add the sensor")).toBeInTheDocument();
    fireEvent.click(within(again).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Add Door or Window" })).toBeNull();
  });

  it("moves and removes sensors", async () => {
    vi.mocked(sc.saveContactSensor).mockResolvedValue(data());
    vi.mocked(sc.deleteContactSensor).mockResolvedValue(data());
    await ready();
    fireEvent.change(screen.getByLabelText("What Front Door pauses"), {
      target: { value: "room:r2" },
    });
    await waitFor(() =>
      expect(sc.saveContactSensor).toHaveBeenCalledWith("binary_sensor.front_door", {
        room_id: "r2",
      })
    );
    fireEvent.change(screen.getByLabelText("What Porch Door pauses"), {
      target: { value: "zone:climate.north" },
    });
    await waitFor(() =>
      expect(sc.saveContactSensor).toHaveBeenCalledWith("binary_sensor.porch_door", {
        thermostat_entity_id: "climate.north",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Porch Door" }));
    await waitFor(() =>
      expect(sc.deleteContactSensor).toHaveBeenCalledWith("binary_sensor.porch_door")
    );

    vi.mocked(sc.saveContactSensor).mockRejectedValueOnce(new Error("That room does not exist"));
    fireEvent.change(screen.getByLabelText("What Front Door pauses"), {
      target: { value: "room:r1" },
    });
    expect(await screen.findByText("That room does not exist")).toBeInTheDocument();
    vi.mocked(sc.saveContactSensor).mockRejectedValueOnce(0);
    fireEvent.change(screen.getByLabelText("What Front Door pauses"), {
      target: { value: "room:r2" },
    });
    expect(await screen.findByText("Could not move the sensor")).toBeInTheDocument();
    vi.mocked(sc.deleteContactSensor).mockRejectedValueOnce(new Error("Sensor not found"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Front Door" }));
    expect(await screen.findByText("Sensor not found")).toBeInTheDocument();
    vi.mocked(sc.deleteContactSensor).mockRejectedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Remove Front Door" }));
    expect(await screen.findByText("Could not remove the sensor")).toBeInTheDocument();
  });

  it("edits zone and room overrides", async () => {
    const withOverrides = data({
      overrides: [
        { scope: "zone", scope_id: "climate.north", key: "zone_pause_min", value: 1 },
        { scope: "room", scope_id: "r1", key: "room_pause_enabled", value: false },
      ],
    });
    vi.mocked(sc.getSmartControl).mockResolvedValue(withOverrides);
    vi.mocked(sc.setOpeningOverride).mockResolvedValue(withOverrides);
    await ready();
    const link = screen.getByRole("button", { name: "Zone Pause After 1 Min (Override)" });
    fireEvent.click(link);
    expect(link).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Pause Room delay for Kitchen")).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Pause Zone for North Wing"));
    await waitFor(() =>
      expect(sc.setOpeningOverride).toHaveBeenCalledWith("zone", "climate.north", {
        zone_pause_enabled: false,
      })
    );
    const roomMin = screen.getByLabelText("Pause Room delay for Great Room");
    fireEvent.change(roomMin, { target: { value: "9" } });
    fireEvent.blur(roomMin);
    await waitFor(() =>
      expect(sc.setOpeningOverride).toHaveBeenCalledWith("room", "r2", { room_pause_min: 9 })
    );
    const resume = screen.getByLabelText("Resume delay for North Wing");
    fireEvent.change(resume, { target: { value: "0" } });
    fireEvent.blur(resume);
    await waitFor(() =>
      expect(sc.setOpeningOverride).toHaveBeenCalledWith("zone", "climate.north", {
        resume_min: 0,
      })
    );
    const zoneMin = screen.getByLabelText("Pause Zone delay for North Wing");
    fireEvent.change(zoneMin, { target: { value: "2" } });
    fireEvent.blur(zoneMin);
    await waitFor(() =>
      expect(sc.setOpeningOverride).toHaveBeenCalledWith("zone", "climate.north", {
        zone_pause_min: 2,
      })
    );

    const useDefaults = screen.getAllByRole("button", { name: "Use Defaults" });
    expect(useDefaults[2]).toBeDisabled(); // Great Room has no override
    fireEvent.click(useDefaults[1]);
    await waitFor(() =>
      expect(sc.setOpeningOverride).toHaveBeenCalledWith("room", "r1", {
        room_pause_enabled: null,
        room_pause_min: null,
        resume_min: null,
      })
    );
    fireEvent.click(useDefaults[0]);
    await waitFor(() =>
      expect(sc.setOpeningOverride).toHaveBeenCalledWith("zone", "climate.north", {
        zone_pause_enabled: null,
        zone_pause_min: null,
        resume_min: null,
      })
    );

    vi.mocked(sc.setOpeningOverride).mockRejectedValueOnce(new Error("Only some keys"));
    fireEvent.click(screen.getByLabelText("Pause Room for Kitchen"));
    expect(await screen.findByText("Only some keys")).toBeInTheDocument();
    vi.mocked(sc.setOpeningOverride).mockRejectedValueOnce(undefined);
    fireEvent.click(screen.getByLabelText("Pause Room for Kitchen"));
    expect(await screen.findByText("Could not save the override")).toBeInTheDocument();

    fireEvent.click(link);
    expect(screen.queryByLabelText("Pause Zone for North Wing")).toBeNull();
  });

  it("labels a zone whose pause is overridden off, and an unnamed zone", async () => {
    vi.mocked(sc.getSmartControl).mockResolvedValue(
      data({
        overrides: [
          { scope: "zone", scope_id: "climate.empty", key: "zone_pause_enabled", value: false },
        ],
        sensors: [
          {
            entity_id: "binary_sensor.shed",
            name: "Shed Door",
            thermostat_entity_id: "climate.empty",
            room_id: null,
            state: "open",
            open_since: null,
            pausing: false,
          },
          {
            entity_id: "binary_sensor.lost",
            name: "Lost Door",
            thermostat_entity_id: null,
            room_id: "gone",
            state: "closed",
            open_since: null,
            pausing: false,
          },
        ],
      })
    );
    render(<SmartControl />);
    expect(await screen.findByText("Zone Pause Off (Override)")).toBeInTheDocument();
    expect(screen.getAllByText("climate.empty")).toHaveLength(2);
    expect(screen.getByText("Open")).toBeInTheDocument();
    // A sensor whose room is unknown has no zone to show under.
    expect(screen.queryByText("Lost Door")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Zone Pause Off (Override)" }));
    expect(screen.getByLabelText("Pause Zone for climate.empty")).not.toBeChecked();
  });

  it("refreshes open timers every 30 seconds and ignores refresh failures", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { unmount } = render(<SmartControl />);
    await act(async () => {
      await Promise.resolve();
    });
    await screen.findByText("Front Door");
    expect(sc.getSmartControl).toHaveBeenCalledTimes(1);
    vi.mocked(sc.getSmartControl).mockRejectedValueOnce(new Error("blip"));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(sc.getSmartControl).toHaveBeenCalledTimes(3);
    expect(await screen.findByText("Open 7 Min, Pausing")).toBeInTheDocument();
    unmount();
  });

  it("ignores a load that finishes after unmount", async () => {
    let resolve: (d: sc.SmartControl) => void = () => {};
    vi.mocked(sc.getSmartControl).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { unmount } = render(<SmartControl />);
    unmount();
    resolve(data());
    await Promise.resolve();
    let reject: (e: Error) => void = () => {};
    vi.mocked(sc.getSmartControl).mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    const second = render(<SmartControl />);
    second.unmount();
    reject(new Error("late"));
    await Promise.resolve();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});
