import { beforeEach, describe, expect, it, vi } from "vitest";
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

const show = (unit: "F" | "C" = "F") =>
  render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <EcoSection />
    </UnitContext.Provider>
  );

const card = () => screen.findByRole("group", { name: "Upstairs" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getThermostats).mockResolvedValue([zone()]);
  vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
    entity_id: "sensor.outside",
  } as Awaited<ReturnType<typeof api.getOutsideTempEntity>>);
  vi.mocked(api.updateThermostat).mockImplementation(async (_id, patch) =>
    zone(patch as Partial<api.ThermostatConfig>)
  );
});

describe("Smart Control → Eco Mode", () => {
  it("shows each zone's settings and saves only the Eco fields", async () => {
    show();
    expect(screen.getByText("Loading the zones…")).toBeInTheDocument();
    const c = await card();
    const toggle = within(c).getByRole("switch", { name: "Eco Mode for Upstairs" });
    expect(toggle).not.toBeChecked();
    const save = within(c).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled(); // nothing changed yet
    expect(within(c).getByTestId("eco-worked-example")).toBeInTheDocument();

    fireEvent.click(toggle);
    fireEvent.change(within(c).getByLabelText(/Cooling — outdoor threshold/), {
      target: { value: "92" },
    });
    fireEvent.click(save);
    await waitFor(() => expect(api.updateThermostat).toHaveBeenCalled());
    const [id, payload] = vi.mocked(api.updateThermostat).mock.calls[0];
    expect(id).toBe("climate.up");
    expect(payload).toEqual({
      eco_mode_enabled: true,
      eco_cooling_outdoor_threshold: 92,
      eco_cooling_full_drift_temp: 100,
      eco_cooling_max_drift: 4,
      eco_heating_outdoor_threshold: 40,
      eco_heating_full_drift_temp: 0,
      eco_heating_max_drift: 4,
      eco_hysteresis_band: 2,
    });
    expect(await within(c).findByText("Saved")).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Save" })).toBeDisabled();
    // Editing again clears the confirmation.
    fireEvent.change(within(c).getByLabelText(/Hysteresis band/), { target: { value: "3" } });
    expect(within(c).queryByText("Saved")).not.toBeInTheDocument();
  });

  it("sends what a Celsius house typed, unconverted (#231)", async () => {
    show("C");
    const c = await card();
    // 86 °F shows as 30 °C; a 4 °F drift shows as 2.22 °C.
    expect(within(c).getByLabelText(/Cooling — outdoor threshold \(°C\)/)).toHaveDisplayValue("30");
    fireEvent.change(within(c).getByLabelText(/Cooling — outdoor threshold/), {
      target: { value: "31" },
    });
    fireEvent.change(within(c).getByLabelText(/Heating — max drift/), { target: { value: "2" } });
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateThermostat).toHaveBeenCalled());
    const [, payload] = vi.mocked(api.updateThermostat).mock.calls[0];
    expect(payload.eco_cooling_outdoor_threshold).toBe(31);
    expect(payload.eco_heating_max_drift).toBe(2);
  });

  it("will not turn Eco on without an outside temperature sensor", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: null,
    } as unknown as Awaited<ReturnType<typeof api.getOutsideTempEntity>>);
    show();
    const c = await card();
    expect(screen.getByText(/no outside temperature sensor is chosen/)).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("switch"));
    expect(within(c).getByText(/Eco Mode needs an outside temperature sensor/)).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Save" })).toBeDisabled();
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
    fireEvent.change(within(c).getByLabelText(/Hysteresis band/), { target: { value: "" } });
    expect(within(c).getByText("Every field needs a number.")).toBeInTheDocument();
    expect(within(c).getByLabelText(/Hysteresis band/)).toHaveDisplayValue("");
    expect(within(c).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("reports a refused save and keeps what was typed", async () => {
    vi.mocked(api.updateThermostat).mockRejectedValueOnce(new Error("Eco needs a sensor"));
    show();
    const c = await card();
    fireEvent.change(within(c).getByLabelText(/Hysteresis band/), { target: { value: "3" } });
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    expect(await within(c).findByText("Eco needs a sensor")).toBeInTheDocument();
    expect(within(c).getByLabelText(/Hysteresis band/)).toHaveDisplayValue("3");
    vi.mocked(api.updateThermostat).mockRejectedValueOnce("x");
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    expect(await within(c).findByText("Could not save")).toBeInTheDocument();
  });

  it("shows blanks for a zone stored without Eco values", async () => {
    vi.mocked(api.getThermostats).mockResolvedValue([
      zone({
        eco_mode_enabled: null,
        eco_hysteresis_band: null,
      } as unknown as Partial<api.ThermostatConfig>),
    ]);
    show();
    const c = await card();
    expect(within(c).getByRole("switch")).not.toBeChecked();
  });

  it("saves one zone without disturbing another", async () => {
    vi.mocked(api.getThermostats).mockResolvedValue([
      zone(),
      zone({ thermostat_entity_id: "climate.den", name: "Den" }),
    ]);
    show();
    const den = await screen.findByRole("group", { name: "Den" });
    const up = await card();
    fireEvent.change(within(den).getByLabelText(/Hysteresis band/), { target: { value: "5" } });
    fireEvent.change(within(up).getByLabelText(/Hysteresis band/), { target: { value: "3" } });
    fireEvent.click(within(up).getByRole("button", { name: "Save" }));
    await within(up).findByText("Saved");
    expect(within(den).getByLabelText(/Hysteresis band/)).toHaveDisplayValue("5");
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
