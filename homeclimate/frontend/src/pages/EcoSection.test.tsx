import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import EcoSection from "./EcoSection";
import * as api from "../api";
import { buildUnitContext, UnitContext } from "../contexts";
import { ecoThermostatDefaults } from "../testFixtures";

vi.mock("../api");

const zone = (over: Partial<api.ThermostatConfig> = {}): api.ThermostatConfig =>
  ({
    thermostat_entity_id: "climate.up",
    name: "Upstairs",
    ...ecoThermostatDefaults,
    ...over,
  }) as api.ThermostatConfig;

const show = (unit: "F" | "C" = "F") => {
  houseUnit = unit;
  return render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <EcoSection />
    </UnitContext.Provider>
  );
};

const card = () => screen.findByRole("group", { name: "Upstairs" });

const DELTAS = ["eco_cooling_max_drift", "eco_heating_max_drift", "eco_hysteresis_band"];
let houseUnit: "F" | "C" = "F";
let stored: api.ThermostatConfig;

/** What the backend does: convert what was typed to °F (2dp) and return the whole zone. */
const store = (patch: Record<string, unknown>) => {
  const next: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== "number" || houseUnit === "F" || key === "eco_empty_zone_hours") {
      next[key] = typeof value === "number" ? Math.round(value * 100) / 100 : value;
    } else {
      const f = DELTAS.includes(key) ? (value * 9) / 5 : (value * 9) / 5 + 32;
      next[key] = Math.round(f * 100) / 100;
    }
  }
  stored = next as unknown as api.ThermostatConfig;
  return stored;
};

beforeEach(() => {
  vi.clearAllMocks();
  houseUnit = "F";
  stored = zone({ eco_mode_enabled: true });
  vi.mocked(api.getThermostats).mockImplementation(async () => [stored]);
  vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
    entity_id: "sensor.outside",
  } as Awaited<ReturnType<typeof api.getOutsideTempEntity>>);
  vi.mocked(api.updateThermostat).mockImplementation(async (_id, patch) =>
    store(patch as Record<string, unknown>)
  );
});

describe("Smart Control → Eco Mode", () => {
  it("shows each zone's settings and saves only what was changed", async () => {
    stored = zone();
    show();
    expect(screen.getByText("Loading the zones…")).toBeInTheDocument();
    const c = await card();
    const toggle = within(c).getByRole("switch", { name: "Eco Mode for Upstairs" });
    expect(toggle).not.toBeChecked();
    const save = within(c).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled(); // nothing changed yet
    // Off, a zone is one line.
    expect(
      within(c).getByText("Off. Rooms hold their targets in any weather.")
    ).toBeInTheDocument();
    expect(within(c).queryByRole("slider")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(within(c).getAllByRole("slider")).toHaveLength(4);
    expect(
      within(c).getByRole("img", {
        name: "Rooms hold their target between 40°F and 86°F outside. Colder than that they run up to 4°F cooler; hotter, up to 4°F warmer.",
      })
    ).toBeInTheDocument();
    fireEvent.change(within(c).getByLabelText("Start When Outside Is Above"), {
      target: { value: "92" },
    });
    fireEvent.click(save);
    await waitFor(() => expect(api.updateThermostat).toHaveBeenCalled());
    const [id, payload] = vi.mocked(api.updateThermostat).mock.calls[0];
    expect(id).toBe("climate.up");
    // Only what was changed is sent; the other six numbers are left alone.
    expect(payload).toEqual({ eco_mode_enabled: true, eco_cooling_outdoor_threshold: 92 });
    expect(await within(c).findByText("Saved")).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Save" })).toBeDisabled();
    // Editing again clears the confirmation.
    fireEvent.change(within(c).getByLabelText(/^Keep drifting until outside comes back by/), {
      target: { value: "3" },
    });
    expect(within(c).queryByText("Saved")).not.toBeInTheDocument();
  });

  it("sends what a Celsius house typed, unconverted (#231)", async () => {
    show("C");
    const c = await card();
    // 86 °F shows as 30 °C; a 4 °F drift shows as 2.22 °C.
    expect(within(c).getByLabelText("Start When Outside Is Above")).toHaveDisplayValue("30");
    fireEvent.change(within(c).getByLabelText("Start When Outside Is Above"), {
      target: { value: "31" },
    });
    fireEvent.change(within(c).getByLabelText("Let Rooms Run Cooler By Up To"), {
      target: { value: "2" },
    });
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateThermostat).toHaveBeenCalled());
    const [, payload] = vi.mocked(api.updateThermostat).mock.calls[0];
    expect(payload).toEqual({ eco_cooling_outdoor_threshold: 31, eco_heating_max_drift: 2 });
    // The backend stored 87.8 °F and 3.6 °F; the form still shows what was typed.
    expect(await within(c).findByText("Saved")).toBeInTheDocument();
    expect(stored.eco_cooling_outdoor_threshold).toBe(87.8);
    expect(within(c).getByLabelText("Start When Outside Is Above")).toHaveDisplayValue("31");
    expect(within(c).getByLabelText("Let Rooms Run Cooler By Up To")).toHaveDisplayValue("2");
    expect(within(c).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("does not rewrite a Celsius zone's untouched values when only the switch changes", async () => {
    // 100 °F shows as 37.8 °C, which would store back as 100.04 °F if it were resent.
    stored = zone();
    show("C");
    const c = await card();
    fireEvent.click(within(c).getByRole("switch", { name: /^Eco Mode for/ }));
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    await within(c).findByText("Saved");
    expect(vi.mocked(api.updateThermostat).mock.calls[0][1]).toEqual({ eco_mode_enabled: true });
    expect(stored.eco_cooling_full_drift_temp).toBe(100);
  });

  it("settles after a save even when what was typed rounds to what was shown", async () => {
    show();
    const c = await card();
    const field = within(c).getByLabelText(/^Keep drifting until outside comes back by/);
    fireEvent.change(field, { target: { value: "2.004" } });
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    expect(await within(c).findByText("Saved")).toBeInTheDocument();
    expect(field).toHaveDisplayValue("2");
    expect(within(c).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("locks the switch and the numbers while a save is on its way", async () => {
    let finish: (z: api.ThermostatConfig) => void = () => {};
    vi.mocked(api.updateThermostat).mockReturnValueOnce(new Promise((r) => (finish = r)));
    show();
    const c = await card();
    fireEvent.change(within(c).getByLabelText(/^Keep drifting until outside comes back by/), {
      target: { value: "3" },
    });
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    expect(within(c).getByRole("switch", { name: /^Eco Mode for/ })).toBeDisabled();
    expect(within(c).getByLabelText(/^Keep drifting until outside comes back by/)).toBeDisabled();
    expect(
      within(c).getByRole("switch", { name: "Let an Empty Zone Drift Further" })
    ).toBeDisabled();
    expect(within(c).getByRole("button", { name: "Saving…" })).toBeDisabled();
    finish(store({ eco_hysteresis_band: 3 }));
    await within(c).findByText("Saved");
    expect(within(c).getByRole("switch", { name: /^Eco Mode for/ })).toBeEnabled();
  });

  it("keeps an edit through React's double render", async () => {
    render(
      <StrictMode>
        <UnitContext.Provider value={buildUnitContext("F")}>
          <EcoSection />
        </UnitContext.Provider>
      </StrictMode>
    );
    const c = await card();
    fireEvent.change(within(c).getByLabelText(/^Keep drifting until outside comes back by/), {
      target: { value: "3" },
    });
    expect(
      within(c).getByLabelText(/^Keep drifting until outside comes back by/)
    ).toHaveDisplayValue("3");
    expect(within(c).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows the house's unit once it is known, when that arrives after the zones", async () => {
    const view = show();
    const c = await card();
    expect(within(c).getByLabelText("Start When Outside Is Above")).toHaveDisplayValue("86");
    view.rerender(
      <UnitContext.Provider value={buildUnitContext("C")}>
        <EcoSection />
      </UnitContext.Provider>
    );
    expect(within(c).getByLabelText("Start When Outside Is Above")).toHaveDisplayValue("30");
    expect(within(c).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("never reaches the full drift before the drift starts", async () => {
    show();
    const c = await card();
    // Dragged past where the full drift was, each start takes it along.
    fireEvent.change(within(c).getByLabelText("Start When Outside Is Above"), {
      target: { value: "104" },
    });
    fireEvent.change(within(c).getByLabelText("Start When Outside Is Below"), {
      target: { value: "-4" },
    });
    fireEvent.change(within(c).getByLabelText("Let Rooms Run Warmer By Up To"), {
      target: { value: "6" },
    });
    expect(within(c).getByLabelText(/^Hot days: full drift/)).toHaveDisplayValue("104");
    expect(within(c).getByLabelText(/^Cold days: full drift/)).toHaveDisplayValue("-4");
    expect(within(c).getByText("6°F")).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    await within(c).findByText("Saved");
    expect(vi.mocked(api.updateThermostat).mock.calls[0][1]).toEqual({
      eco_cooling_outdoor_threshold: 104,
      eco_cooling_full_drift_temp: 104,
      eco_heating_outdoor_threshold: -4,
      eco_heating_full_drift_temp: -4,
      eco_cooling_max_drift: 6,
    });
    // With no drift allowed at all the picture is a flat line, not a division by zero.
    fireEvent.change(within(c).getByLabelText("Let Rooms Run Warmer By Up To"), {
      target: { value: "0" },
    });
    fireEvent.change(within(c).getByLabelText("Let Rooms Run Cooler By Up To"), {
      target: { value: "0" },
    });
    expect(c.querySelector(".eco-chart-line")!.getAttribute("points")).not.toContain("NaN");
  });

  it("names a zone with no name by its thermostat", async () => {
    stored = zone({ name: "" });
    show();
    const c = await screen.findByRole("group", { name: "Up" });
    expect(within(c).getByRole("switch", { name: "Eco Mode for Up" })).toBeInTheDocument();
  });

  it("will not turn Eco on without an outside temperature sensor", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: null,
    } as unknown as Awaited<ReturnType<typeof api.getOutsideTempEntity>>);
    stored = zone();
    show();
    const c = await card();
    expect(screen.getByText(/no outside temperature sensor is chosen/)).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("switch", { name: /^Eco Mode for/ }));
    expect(within(c).getByText(/Eco Mode needs an outside temperature sensor/)).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("still lets a zone that is already on be tuned without a sensor", async () => {
    vi.mocked(api.getOutsideTempEntity).mockRejectedValue(new Error("down"));
    stored = zone({ eco_mode_enabled: true });
    show();
    const c = await card();
    fireEvent.change(within(c).getByLabelText(/^Keep drifting until outside comes back by/), {
      target: { value: "3" },
    });
    expect(within(c).queryByText(/Eco Mode needs an outside/)).not.toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    await within(c).findByText("Saved");
    expect(vi.mocked(api.updateThermostat).mock.calls[0][1]).toEqual({ eco_hysteresis_band: 3 });
  });

  it("treats a failed sensor lookup as no sensor, and still lists the zones", async () => {
    vi.mocked(api.getOutsideTempEntity).mockRejectedValue(new Error("down"));
    show();
    await card();
    expect(screen.getByText(/no outside temperature sensor is chosen/)).toBeInTheDocument();
  });

  it("needs a number in every field", async () => {
    show();
    const c = await card();
    fireEvent.change(within(c).getByLabelText(/^Keep drifting until outside comes back by/), {
      target: { value: "" },
    });
    expect(within(c).getByText("Every field needs a number.")).toBeInTheDocument();
    expect(
      within(c).getByLabelText(/^Keep drifting until outside comes back by/)
    ).toHaveDisplayValue("");
    expect(within(c).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("reports a refused save and keeps what was typed", async () => {
    vi.mocked(api.updateThermostat).mockRejectedValueOnce(new Error("Eco needs a sensor"));
    show();
    const c = await card();
    fireEvent.change(within(c).getByLabelText(/^Keep drifting until outside comes back by/), {
      target: { value: "3" },
    });
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    expect(await within(c).findByText("Eco needs a sensor")).toBeInTheDocument();
    expect(
      within(c).getByLabelText(/^Keep drifting until outside comes back by/)
    ).toHaveDisplayValue("3");
    vi.mocked(api.updateThermostat).mockRejectedValueOnce("x");
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    expect(await within(c).findByText("Could not save")).toBeInTheDocument();
  });

  it("shows the switch off for a zone stored without an Eco setting", async () => {
    stored = zone({ eco_mode_enabled: null } as unknown as Partial<api.ThermostatConfig>);
    show();
    const c = await card();
    expect(within(c).getByRole("switch", { name: /^Eco Mode for/ })).not.toBeChecked();
  });

  it("saves one zone without disturbing another", async () => {
    vi.mocked(api.getThermostats).mockResolvedValue([
      zone({ eco_mode_enabled: true }),
      zone({ eco_mode_enabled: true, thermostat_entity_id: "climate.den", name: "Den" }),
    ]);
    show();
    const den = await screen.findByRole("group", { name: "Den" });
    const up = await card();
    fireEvent.change(within(den).getByLabelText(/^Keep drifting until outside comes back by/), {
      target: { value: "5" },
    });
    fireEvent.change(within(up).getByLabelText(/^Keep drifting until outside comes back by/), {
      target: { value: "3" },
    });
    fireEvent.click(within(up).getByRole("button", { name: "Save" }));
    await within(up).findByText("Saved");
    expect(
      within(den).getByLabelText(/^Keep drifting until outside comes back by/)
    ).toHaveDisplayValue("5");
  });

  it("lets an empty zone drift further after a set number of hours", async () => {
    show();
    const c = await card();
    const hours = within(c).getByLabelText("Hours before Upstairs drifts further");
    const toggle = within(c).getByRole("switch", { name: "Let an Empty Zone Drift Further" });
    expect(toggle).not.toBeChecked();
    expect(hours).toBeDisabled();
    expect(hours).toHaveValue(null);
    expect(
      within(c).getByText("After nobody has used the zone this long, rooms may drift 2°F more.")
    ).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(hours).toHaveValue(2);
    // Typing "0.5" passes through "0": the row stays on while it is typed.
    fireEvent.change(hours, { target: { value: "0" } });
    expect(toggle).toBeChecked();
    expect(hours).toBeEnabled();
    expect(within(c).getByText("Hours must be between 0.5 and 72.")).toBeInTheDocument();
    fireEvent.change(hours, { target: { value: "4.5" } });
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateThermostat).toHaveBeenCalledWith("climate.up", { eco_empty_zone_hours: 4.5 })
    );
    expect(await within(c).findByText("Saved")).toBeInTheDocument();

    fireEvent.click(toggle);
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateThermostat).toHaveBeenLastCalledWith("climate.up", {
        eco_empty_zone_hours: 0,
      })
    );
  });

  it("shows the extra drift in the house's unit and refuses hours out of range", async () => {
    stored = zone({ eco_mode_enabled: true, eco_empty_zone_hours: 3 });
    show("C");
    const c = await card();
    expect(within(c).getByText(/rooms may drift 1\.11°C more/)).toBeInTheDocument();
    const hours = within(c).getByLabelText("Hours before Upstairs drifts further");
    expect(hours).toHaveValue(3);
    for (const bad of ["80", "", "-1", "0.2"]) {
      fireEvent.change(hours, { target: { value: bad } });
      expect(within(c).getByText("Hours must be between 0.5 and 72.")).toBeInTheDocument();
      expect(within(c).getByRole("button", { name: "Save" })).toBeDisabled();
    }
    fireEvent.change(hours, { target: { value: "6" } });
    expect(within(c).queryByText("Hours must be between 0.5 and 72.")).not.toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("says so with no zones, when it cannot load, and ignores late responses", async () => {
    vi.mocked(api.getThermostats).mockResolvedValueOnce([]);
    const first = show();
    expect(await screen.findByText(/Add a zone in My Home/)).toBeInTheDocument();
    first.unmount();
    vi.mocked(api.getThermostats).mockRejectedValueOnce(new Error("down"));
    const second = show();
    expect(await screen.findByText("Could not load the zones.")).toBeInTheDocument();
    second.unmount();
    let finish: (z: api.ThermostatConfig[]) => void = () => {};
    vi.mocked(api.getThermostats).mockReturnValueOnce(new Promise((r) => (finish = r)));
    const third = show();
    third.unmount();
    finish([zone()]);
    let fail: (e: Error) => void = () => {};
    vi.mocked(api.getThermostats).mockReturnValueOnce(new Promise((_r, j) => (fail = j)));
    const fourth = show();
    fourth.unmount();
    fail(new Error("late"));
    await Promise.resolve();
  });
});
