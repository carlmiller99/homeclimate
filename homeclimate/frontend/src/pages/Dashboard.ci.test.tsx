import { describe, it, expect, vi, afterEach } from "vitest";
import { ecoRoomDefaults } from "../testFixtures";
import { within, render, screen } from "@testing-library/react";

// The live active-rooms list is frozen out of the golden under CI (engine-driven,
// non-deterministic). To keep the requesting-temp line and the Clear-presence
// button under visual-regression coverage, Dashboard renders a fixed sample row
// in the frozen slot on the first zone card. This exercises that CI-only branch:
// the module-level isCI flag is derived from VITE_APP_VERSION, so we stub it and
// re-import with a fresh module registry (same approach as ci.test.tsx).

vi.mock("../api");
vi.mock("../smartControlApi", async (orig) => ({
  ...(await orig<typeof import("../smartControlApi")>()),
  getSmartControl: vi
    .fn()
    .mockResolvedValue({ settings: {}, overrides: [], sensors: [], paused: [] }),
}));
vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getZones: vi.fn().mockResolvedValue([]),
  getBuildings: vi.fn().mockResolvedValue([]),
}));

const mockStatus = [
  {
    thermostat_entity_id: "climate.test",
    hvac_mode: "cool",
    hvac_action: "cooling",
    current_temp: 75.2,
    setpoint: 72.0,
    cycle_state: "running" as const,
    cycle_id: "c1",
    cycle_started_at: "2024-01-01T12:00:00",
    rooms: [
      {
        room_id: "room-1",
        avg_temp: 76.1,
        presence_active: true,
        vent_states: { "cover.vent": "open" },
        target_temp: 72.0,
      },
    ],
  },
];

describe("Dashboard — CI build", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("renders the deterministic active-rooms sample (with Clear presence) in place of the frozen live list", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_APP_VERSION", "CI");

    const api = await import("../api");
    vi.mocked(api.getSensorHealth).mockResolvedValue({ stale_after_min: 30, rooms: [] });
    vi.mocked(api.getSensorStaleness).mockResolvedValue({ stale_after_min: 30 });
    vi.mocked(api.getThermostatHealth).mockResolvedValue({ thermostats: [] });
    vi.mocked(api.getStatus).mockResolvedValue(mockStatus);
    vi.mocked(api.connectWS).mockReturnValue(() => {});
    // Room sensor lists and readings for the per-room temperatures.
    vi.mocked(api.getRoom).mockImplementation(async (id) => ({ id, sensors: [] }) as never);
    vi.mocked(api.getEntityStates).mockResolvedValue({});
    vi.mocked(api.getVacationMode).mockResolvedValue({ enabled: false, return_at: null });
    vi.mocked(api.getOverrides).mockResolvedValue([
      {
        room_id: "room-1",
        target_temp: 75,
        expires_at: "2099-01-01T12:00:00",
        respect_eco: false,
        ends_in_seconds: 5400,
      },
    ]);
    vi.mocked(api.getRooms).mockResolvedValue([
      {
        id: "room-1",
        name: "Living Room",
        thermostat_entity_id: "climate.test",
        include_thermostat_sensor: false,
        presence_holdover_hours: 2,
        temp_offset: 0,
        deadband_override: null,
        notes: "",
        system_wide_temp: null,
        ambient_suppression_enabled: false,
        ambient_suppression_mode: "any_presence",
        ambient_suppression_min_differential: 5,
        ambient_suppression_deadband: 2,
        ambient_suppression_off_schedule_window_min: 60,
        ...ecoRoomDefaults,
      },
    ]);
    vi.mocked(api.getThermostats).mockResolvedValue([]);

    const { default: Dashboard } = await import("./Dashboard");

    render(<Dashboard />);

    // The frozen sample is laid over the zone's own room, with its
    // requesting-temp line and Clear-presence button.
    const row = await screen.findByTestId("dash-room-room-1");
    expect(row).toHaveTextContent("Living Room");
    expect(row).toHaveTextContent("71.4°F");
    expect(row).toHaveTextContent(/requesting 68.0°F/);
    expect(screen.getAllByRole("button", { name: /^Clear Presence for / })).toHaveLength(1);
    // A hold is user-set state, not engine-driven, so it still shows.
    expect(
      within(row).getByRole("button", { name: "Cancel Hold for Living Room" })
    ).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /^Hold for / })).toBeNull();
    // The real, engine-driven reading for that room is frozen out under CI.
    expect(screen.queryByText("76.1°F")).not.toBeInTheDocument();
    expect(screen.queryByText(/requesting 72.0°F/)).not.toBeInTheDocument();
  });

  it("shows the sample by id for a zone with no rooms, and nothing for later zones", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_APP_VERSION", "CI");

    const api = await import("../api");
    vi.mocked(api.getSensorHealth).mockResolvedValue({ stale_after_min: 30, rooms: [] });
    vi.mocked(api.getSensorStaleness).mockResolvedValue({ stale_after_min: 30 });
    vi.mocked(api.getThermostatHealth).mockResolvedValue({ thermostats: [] });
    vi.mocked(api.getStatus).mockResolvedValue([
      mockStatus[0],
      { ...mockStatus[0], thermostat_entity_id: "climate.other" },
    ]);
    vi.mocked(api.connectWS).mockReturnValue(() => {});
    vi.mocked(api.getVacationMode).mockResolvedValue({ enabled: false, return_at: null });
    vi.mocked(api.getOverrides).mockResolvedValue([]);
    vi.mocked(api.getRooms).mockResolvedValue([]);
    vi.mocked(api.getThermostats).mockResolvedValue([]);

    const { default: Dashboard } = await import("./Dashboard");
    render(<Dashboard />);

    expect(await screen.findByText("Bedroom")).toBeInTheDocument();
    expect(screen.getByText("Office")).toBeInTheDocument();
    expect(screen.getByText(/requesting 68.0°F/)).toBeInTheDocument();
    expect(screen.getByText(/requesting 70.0°F/)).toBeInTheDocument();
    // Only the first zone carries the sample; the second renders no rooms.
    expect(screen.getAllByRole("button", { name: /^Clear Presence for / })).toHaveLength(2);
    expect(screen.queryByText("room-1")).not.toBeInTheDocument();
  });
});
