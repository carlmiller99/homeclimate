import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import Dashboard from "./Dashboard";
import * as api from "../api";
import { SystemContext, DevModeContext, UnitContext, buildUnitContext } from "../contexts";
import { ecoThermostatDefaults, ecoRoomDefaults, makeHold } from "../testFixtures";

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
  getSmartControl: vi
    .fn()
    .mockResolvedValue({ settings: {}, overrides: [], sensors: [], paused: [] }),
}));
vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getZones: vi.fn().mockResolvedValue([]),
  getBuildings: vi.fn().mockResolvedValue([]),
}));

const mockSystem = { enabled: true, toggle: vi.fn().mockResolvedValue(undefined) };
const mockDevMode = { devMode: false, toggleDevMode: vi.fn().mockResolvedValue(undefined) };

const room = (id: string, name: string, thermostat = "climate.a"): api.Room => ({
  id,
  name,
  thermostat_entity_id: thermostat,
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
});

const thermostat = (entity: string, name: string): api.ThermostatConfig => ({
  thermostat_entity_id: entity,
  name,
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
});

const renderDashboard = (unit: "F" | "C" = "F") =>
  render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <SystemContext.Provider value={mockSystem}>
        <DevModeContext.Provider value={mockDevMode}>
          <Dashboard />
        </DevModeContext.Provider>
      </SystemContext.Provider>
    </UnitContext.Provider>
  );

/** The zone card for a thermostat, located by its entity-id subtitle. */
const cardFor = (entityId: string): HTMLElement => screen.getByTestId(`dash-zone-${entityId}`);

describe("Dashboard — uncovered branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSensorHealth).mockResolvedValue({ stale_after_min: 30, rooms: [] });
    vi.mocked(api.getSensorStaleness).mockResolvedValue({ stale_after_min: 30 });
    vi.mocked(api.getThermostatHealth).mockResolvedValue({ thermostats: [] });
    vi.mocked(api.connectWS).mockReturnValue(() => {});
    // Room sensor lists and readings for the per-room temperatures.
    vi.mocked(api.getRoom).mockImplementation(
      async (id) => ({ id, sensors: [] }) as unknown as api.Room
    );
    vi.mocked(api.getEntityStates).mockResolvedValue({});
    vi.mocked(api.getVacationMode).mockResolvedValue({ enabled: false, return_at: null });
    vi.mocked(api.getOverrides).mockResolvedValue([]);
    vi.mocked(api.getStatus).mockResolvedValue([]);
    vi.mocked(api.getRooms).mockResolvedValue([]);
    vi.mocked(api.getThermostats).mockResolvedValue([]);
  });

  // ── per-room vent counter ─────────────────────────────────────────────────

  // Every other fixture on this page gives a room exactly ONE vent, which makes
  // "open count" and "total count" the same number — so a counter that simply
  // reported `ventEntries.length` would render "1/1 open" and pass everywhere.
  // A room with a mix of open and closed vents is the only shape that tells the
  // two apart, and multi-vent rooms are the normal case in a real install.
  it("counts only the OPEN vents in the per-room x/y summary", async () => {
    vi.mocked(api.getStatus).mockResolvedValue([
      {
        thermostat_entity_id: "climate.a",
        hvac_mode: "cool",
        hvac_action: "cooling",
        current_temp: 76.0,
        setpoint: 72.0,
        cycle_state: "running",
        cycle_id: "c1",
        cycle_started_at: "2024-01-01T12:00:00",
        rooms: [
          {
            room_id: "r1",
            avg_temp: 75.0,
            presence_active: false,
            // Four vents, one open — the counter must read 1/4, not 4/4.
            vent_states: {
              "cover.v1": "open",
              "cover.v2": "closed",
              "cover.v3": "closed",
              "cover.v4": "closed",
            },
            target_temp: 72.0,
          },
          {
            room_id: "r2",
            avg_temp: 74.0,
            presence_active: false,
            // …and a fully-open room, so the counter is not simply always low.
            vent_states: { "cover.v5": "open", "cover.v6": "open" },
            target_temp: 72.0,
          },
        ],
      },
    ]);
    vi.mocked(api.getRooms).mockResolvedValue([room("r1", "Den"), room("r2", "Study")]);
    vi.mocked(api.getThermostats).mockResolvedValue([thermostat("climate.a", "Upstairs")]);

    renderDashboard();
    await screen.findAllByText("Upstairs");

    // The vents are in each room's details.
    fireEvent.click(screen.getByRole("button", { name: "Details for Den" }));
    expect(screen.getByRole("region", { name: "Vents" })).toHaveTextContent("1 of 4 open");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Details for Study" }));
    expect(screen.getByRole("region", { name: "Vents" })).toHaveTextContent("2 of 2 open");
  });

  // ── modeColor / modeLabel (lines 27-39) ───────────────────────────────────

  it("colours and labels a heating zone, and marks the room it is heating", async () => {
    // A heating cycle: modeColor → "orange", modeLabel → "Heating", and the
    // room with an open vent carries a Heating pill.
    vi.mocked(api.getStatus).mockResolvedValue([
      {
        thermostat_entity_id: "climate.a",
        hvac_mode: "heat",
        hvac_action: "heating",
        current_temp: 66.0,
        setpoint: 70.0,
        cycle_state: "running",
        cycle_id: "c1",
        cycle_started_at: "2024-01-01T12:00:00",
        rooms: [
          {
            room_id: "r1",
            // Sensor has not reported yet — the room row shows a dash, not "null".
            avg_temp: null,
            presence_active: false,
            vent_states: { "cover.v1": "closed" },
            target_temp: 70.0,
          },
          {
            room_id: "r2",
            avg_temp: 68.0,
            presence_active: false,
            vent_states: { "cover.v2": "open" },
            target_temp: 70.0,
          },
        ],
      },
    ]);
    vi.mocked(api.getRooms).mockResolvedValue([room("r1", "Den"), room("r2", "Study")]);
    vi.mocked(api.getThermostats).mockResolvedValue([thermostat("climate.a", "Upstairs")]);

    renderDashboard();
    await screen.findAllByText("Upstairs");

    // modeColor("heating") === "orange"; modeLabel("heating", …) === "Heating".
    const card = cardFor("climate.a");
    const badge = card.querySelector(".dash-zone-open .badge") as HTMLElement;
    expect(badge).toHaveTextContent("Heating");
    expect(badge.className).toBe("badge badge-orange");

    // The room with an open vent in a heating cycle is Heating; the zone line
    // counts the same.
    const study = within(card).getByTestId("dash-room-r2");
    expect(within(study).getByText("Heating").className).toBe("badge badge-orange");
    await waitFor(() => expect(card).toHaveTextContent(/1 heating, 1 without a reading/));

    // The room with no reading renders the em-dash placeholder.
    const denRow = screen.getByText("Den").closest(".dash-room") as HTMLElement;
    expect(within(denRow).getByText("—")).toBeInTheDocument();
    // …and the one that has a reading still renders a formatted temperature.
    const studyRow = screen.getByText("Study").closest(".dash-room") as HTMLElement;
    expect(within(studyRow).getByText("68.0°F")).toBeInTheDocument();
  });

  it("falls back to gray/Idle/Off/raw-state for zones the thermostat reports oddly", async () => {
    // Three zones exercising every remaining modeColor/modeLabel arm: an idle
    // zone (gray + "Idle"), an off zone (gray + "Off"), and a state the mapper
    // does not know, which is echoed verbatim.
    const zone = (entity: string, hvac_action: string, hvac_mode: string): api.ZoneStatus => ({
      thermostat_entity_id: entity,
      hvac_mode,
      hvac_action,
      current_temp: 70,
      setpoint: 70,
      cycle_state: "idle",
      cycle_id: null,
      cycle_started_at: null,
      rooms: [],
    });
    vi.mocked(api.getStatus).mockResolvedValue([
      zone("climate.a", "", "idle"),
      zone("climate.b", "", "off"),
      zone("climate.c", "", "heat_cool"),
    ]);
    vi.mocked(api.getThermostats).mockResolvedValue([
      thermostat("climate.a", "Alpha"),
      thermostat("climate.b", "Bravo"),
      thermostat("climate.c", "Charlie"),
    ]);

    renderDashboard();
    await screen.findByText("Alpha");

    expect(within(cardFor("climate.a")).getByText("Idle").className).toBe("badge badge-gray");
    expect(within(cardFor("climate.b")).getByText("Off").className).toBe("badge badge-gray");
    // Unknown state falls through modeLabel's guards and is rendered as-is.
    expect(within(cardFor("climate.c")).getByText("heat_cool").className).toBe("badge badge-gray");
  });

  // ── Zone card with no readings and no active rooms ────────────────────────

  it("renders dashes, and still lists idle rooms, for a zone with no readings", async () => {
    vi.mocked(api.getStatus).mockResolvedValue([
      {
        thermostat_entity_id: "climate.a",
        hvac_mode: "cool",
        hvac_action: "cooling",
        // The thermostat is unreachable: no ambient, no setpoint.
        current_temp: null,
        setpoint: null,
        cycle_state: "idle",
        cycle_id: null,
        cycle_started_at: null,
        rooms: [],
        // Eco Mode: nobody has used the zone for a while.
        empty_drift: true,
      },
    ]);
    vi.mocked(api.getRooms).mockResolvedValue([room("r1", "Den"), room("r2", "Study")]);
    vi.mocked(api.getThermostats).mockResolvedValue([thermostat("climate.a", "Upstairs")]);

    renderDashboard();
    await screen.findAllByText("Upstairs");
    const card = cardFor("climate.a");

    // The thermostat's reading and its setpoint both fall back to the em-dash.
    // The thermostat's reading falls back to the em-dash; no setpoint, no "set to".
    expect(card).toHaveTextContent("Thermostat —");
    expect(card).not.toHaveTextContent("set to");

    // Both rooms are listed, each with a dash and no reading to count.
    await waitFor(() => expect(card).toHaveTextContent("2 without a reading"));
    expect(within(card).getByText("Empty, drifting further")).toBeInTheDocument();
    for (const id of ["r1", "r2"]) {
      const row = within(card).getByTestId(`dash-room-${id}`);
      expect(within(row).getByText("—")).toBeInTheDocument();
    }
  });

  // ── Vacation mode payload guard (line 379) ────────────────────────────────

  it("treats a missing vacation-mode payload as vacation off", async () => {
    // A backend that answers with a bare null (older build / trimmed response)
    // must not blow up reading `.enabled` — the page falls back to "off".
    vi.mocked(api.getVacationMode).mockResolvedValue(null as unknown as api.VacationMode);
    vi.mocked(api.getRooms).mockResolvedValue([room("r1", "Den")]);

    renderDashboard();

    expect(
      await screen.findByRole("button", { name: /Enable vacation mode/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(/Schedules paused until/i)).not.toBeInTheDocument();
  });

  // ── Celsius display contract (CLAUDE.md pitfall #3) ───────────────────────

  it("converts every dashboard temperature for display in Celsius mode", async () => {
    // ZoneStatus temperatures are raw °F on the wire; the display layer is the
    // only place they become °C. A raw `${value}${unitLabel}` concatenation
    // would print "75.2°C" here instead of "24.0°C".
    vi.mocked(api.getStatus).mockResolvedValue([
      {
        thermostat_entity_id: "climate.a",
        hvac_mode: "cool",
        hvac_action: "cooling",
        current_temp: 75.2,
        setpoint: 72.0,
        cycle_state: "running",
        cycle_id: "c1",
        cycle_started_at: "2024-01-01T12:00:00",
        rooms: [
          {
            room_id: "r1",
            avg_temp: 76.1,
            presence_active: false,
            vent_states: { "cover.v1": "open" },
            target_temp: 72.0,
            requested_target: 70.0,
            eco_active: true,
          },
        ],
      },
    ]);
    vi.mocked(api.getRooms).mockResolvedValue([room("r1", "Den")]);
    vi.mocked(api.getThermostats).mockResolvedValue([thermostat("climate.a", "Upstairs")]);
    vi.mocked(api.getOverrides).mockResolvedValue([makeHold({ room_id: "r1" })]);

    renderDashboard("C");
    await screen.findAllByText("Upstairs");

    // Zone ambient / setpoint.
    expect(screen.getByTestId("dash-zone-climate.a")).toHaveTextContent(
      "Thermostat 24.0°C, set to 22.2°C"
    );
    // Room average.
    expect(screen.getByText("24.5°C")).toBeInTheDocument();
    // Eco requested→effective line: both values converted.
    fireEvent.click(screen.getByRole("button", { name: "Details for Den" }));
    expect(screen.getByRole("dialog", { name: "Den details" })).toHaveTextContent(
      "Asking for 22.2°C. Eco Mode relaxed it from 21.1°C."
    );
    // Hold strip target (75 °F).
    expect(screen.getByTestId("dashboard-hold-r1")).toHaveTextContent("23.9°C");
    // None of the raw °F numbers leak into the rendered page.
    expect(screen.queryByText(/75\.2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/76\.1/)).not.toBeInTheDocument();
  });
});
