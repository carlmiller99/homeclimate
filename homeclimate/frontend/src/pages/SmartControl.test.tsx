import { FAN_DEFAULTS, HP_DEFAULTS } from "../zoneFixtures";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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
}));
// Both have their own suites; here they only need to show where they render.
vi.mock("./Schedules", () => ({ default: () => <p>schedules page</p> }));
vi.mock("./LearningSection", () => ({ default: () => <p>learning section</p> }));
vi.mock("./ForecastSection", () => ({ default: () => <p>forecast section</p> }));
vi.mock("./BuildingAutoCard", () => ({ default: () => <p>building auto</p> }));
vi.mock("./EcoSection", () => ({ default: () => <p>eco section</p> }));
vi.mock("./SuggestionsCard", () => ({ default: () => <p>suggestions card</p> }));
vi.mock("./ZoneBalanceSection", () => ({ default: () => <p>zone balance section</p> }));
vi.mock("./FanSection", () => ({ default: () => <p>fan section</p> }));
vi.mock("./PeakSection", () => ({ default: () => <p>peak section</p> }));
vi.mock("./FireplaceSection", () => ({ default: () => <p>fireplace section</p> }));
vi.mock("./ShadesSection", () => ({
  default: ({ rooms }: { rooms: { name: string }[] }) => (
    <p>shades for {rooms.map((r) => r.name).join(", ")}</p>
  ),
}));
vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getZones: vi.fn(),
  getBuildings: vi.fn(),
}));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  getRooms: vi.fn(),
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
  ...FAN_DEFAULTS,
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
        pauses: "room" as const,
      },
      {
        entity_id: "binary_sensor.porch_door",
        name: "Porch Door",
        thermostat_entity_id: null,
        room_id: "r1",
        state: "closed",
        open_since: null,
        pausing: false,
        pauses: "room" as const,
      },
      {
        entity_id: "binary_sensor.bunk_window",
        name: "Bunk Window",
        thermostat_entity_id: null,
        room_id: "r3",
        state: "offline",
        open_since: null,
        pausing: false,
        pauses: "room" as const,
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <SmartControl />
    </MemoryRouter>
  );
}

const DOORS = "/smart-control?section=doors-windows";

async function ready() {
  renderAt(DOORS);
  await screen.findByText("North Wing");
}

describe("Smart Control", () => {
  it("opens on Schedules, with the other sections in the side menu", () => {
    renderAt("/smart-control");
    expect(screen.getByText("schedules page")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Smart Control sections" });
    const schedules = within(nav).getByRole("link", { name: "Schedules" });
    expect(schedules).toHaveAttribute("aria-current", "page");
    expect(schedules).toHaveAttribute("href", "/smart-control?section=schedules");
    const doors = within(nav).getByRole("link", { name: "Doors & Windows" });
    expect(doors).not.toHaveAttribute("aria-current");
    expect(doors).toHaveAttribute("href", "/smart-control?section=doors-windows");
    // Nothing is waiting to be built: every section is a link.
    expect(sc.PLANNED_SECTIONS).toEqual([]);
    expect(within(nav).queryByText("Planned")).toBeNull();
    expect(within(nav).getAllByRole("link")).toHaveLength(10);
    expect(sc.getSmartControl).not.toHaveBeenCalled();
  });

  it("opens the Peak Hours section", () => {
    renderAt("/smart-control?section=peak-hours");
    expect(screen.getByText("peak section")).toBeInTheDocument();
  });

  it("opens the Fan section", () => {
    renderAt("/smart-control?section=fan");
    expect(screen.getByText("fan section")).toBeInTheDocument();
  });

  it("opens the Zone Balance section", () => {
    renderAt("/smart-control?section=zone-balance");
    expect(screen.getByText("zone balance section")).toBeInTheDocument();
  });

  it("opens the Eco Mode section", () => {
    renderAt("/smart-control?section=eco-mode");
    expect(screen.getByText("eco section")).toBeInTheDocument();
  });

  it("falls back to Schedules for an unknown section", () => {
    renderAt("/smart-control?section=nope");
    expect(screen.getByText("schedules page")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Schedules" })).toHaveAttribute("aria-current", "page");
  });

  it("opens Fireplace from the side menu", () => {
    renderAt("/smart-control?section=fireplace");
    expect(screen.getByText("fireplace section")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fireplace" })).toHaveAttribute("aria-current", "page");
  });

  it("opens Smart Learning from the side menu", () => {
    renderAt("/smart-control?section=smart-learning");
    expect(screen.getByText("learning section")).toBeInTheDocument();
    expect(screen.queryByText("schedules page")).toBeNull();
    expect(screen.getByRole("link", { name: "Smart Learning" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("opens Forecasts from the side menu", () => {
    renderAt("/smart-control?section=forecasts");
    expect(screen.getByText("forecast section")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Forecasts" })).toHaveAttribute("aria-current", "page");
  });

  it("shows a loading line, then the rules, overrides and shades", async () => {
    renderAt(DOORS);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await screen.findByText("North Wing");
    expect(screen.queryByText("schedules page")).toBeNull();
    expect(screen.getByRole("link", { name: "Doors & Windows" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByText(sc.OPENINGS_NOTE)).toBeInTheDocument();
    expect(
      screen.getByText(/Add door and window sensors to rooms\s+in My Home/)
    ).toBeInTheDocument();
    expect(screen.getByText("climate.north")).toBeInTheDocument();
    expect(screen.getAllByText("Uses Defaults")).toHaveLength(3);
    // Sensors themselves are edited in My Home, not here.
    expect(screen.queryByText("Front Door")).toBeNull();
    expect(screen.getByText("shades for Kitchen, Great Room, Bunk Room")).toBeInTheDocument();
  });

  it("says where to add zones when there are none", async () => {
    vi.mocked(zonesApi.getZones).mockResolvedValue([]);
    renderAt(DOORS);
    expect(await screen.findByText("No zones yet. Add them in My Home.")).toBeInTheDocument();
  });

  it("reports a failed load", async () => {
    vi.mocked(sc.getSmartControl).mockRejectedValueOnce(new Error("down"));
    renderAt(DOORS);
    expect(
      await screen.findByText("Could not load Smart Control. Check that HomeClimate is running.")
    ).toBeInTheDocument();
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
            pauses: "room" as const,
          },
          {
            entity_id: "binary_sensor.lost",
            name: "Lost Door",
            thermostat_entity_id: null,
            room_id: "gone",
            state: "closed",
            open_since: null,
            pausing: false,
            pauses: "room" as const,
          },
        ],
      })
    );
    renderAt(DOORS);
    expect(await screen.findByText("Zone Pause Off (Override)")).toBeInTheDocument();
    expect(screen.getAllByText("climate.empty")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Zone Pause Off (Override)" }));
    expect(screen.getByLabelText("Pause Zone for climate.empty")).not.toBeChecked();
  });

  it("ignores a load that finishes after unmount", async () => {
    let resolve: (d: sc.SmartControl) => void = () => {};
    vi.mocked(sc.getSmartControl).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { unmount } = renderAt(DOORS);
    unmount();
    resolve(data());
    await Promise.resolve();
    let reject: (e: Error) => void = () => {};
    vi.mocked(sc.getSmartControl).mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    const second = renderAt(DOORS);
    second.unmount();
    reject(new Error("late"));
    await Promise.resolve();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});
