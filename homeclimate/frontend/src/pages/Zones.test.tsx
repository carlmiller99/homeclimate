import { FAN_DEFAULTS, HP_DEFAULTS } from "../zoneFixtures";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import * as zonesApi from "../zonesApi";
import { UnitContext, buildUnitContext } from "../contexts";
import Zones, { AUX_HEAT_EXPLAINER, HEAT_KIT_WARNING } from "./Zones";

vi.mock("../zonesApi", async (orig) => {
  const actual = await orig<typeof import("../zonesApi")>();
  return {
    ...actual,
    getZones: vi.fn(),
    getBuildings: vi.fn(),
    createBuilding: vi.fn(),
    updateBuilding: vi.fn(),
    deleteBuilding: vi.fn(),
    updateZone: vi.fn(),
    getEquipmentHint: vi.fn(),
  };
});

vi.mock("../api");

// The thermostat card has its own suite; here it only needs to hand the zone
// panel its two callbacks.
vi.mock("./Thermostats", () => ({
  ThermostatCard: ({
    config,
    onSaved,
    onDeleted,
  }: {
    config: { thermostat_entity_id: string; name: string };
    onSaved: (c: unknown) => void;
    onDeleted: () => void;
  }) => (
    <div>
      <span>card {config.name}</span>
      <button type="button" onClick={() => onSaved({ ...config, name: "Renamed" })}>
        stub save
      </button>
      <button type="button" onClick={onDeleted}>
        stub delete
      </button>
    </div>
  ),
}));

// The intake field loads the zone's fan state by itself and has its own tests.
vi.mock("../components/AirIntakeField", () => ({
  default: ({ zoneName, onChange }: { zoneName: string; onChange: (v: string) => void }) => (
    <button type="button" onClick={() => onChange("yes")}>{`intake yes for ${zoneName}`}</button>
  ),
}));
vi.mock("../components/EntityPicker", () => ({
  default: ({ onSelect, placeholder }: { onSelect: (id: string) => void; placeholder: string }) => (
    <button type="button" onClick={() => onSelect("climate.wing_cloud")}>
      pick {placeholder}
    </button>
  ),
}));

const MAIN: zonesApi.Building = { id: "b1", name: "Main House", sort_order: 0 };
const DEN: zonesApi.Building = { id: "b2", name: "The Den", sort_order: 1 };

function zone(over: Partial<zonesApi.ZoneProfile>): zonesApi.ZoneProfile {
  return {
    thermostat_entity_id: "climate.a",
    name: "Upstairs",
    building_id: "b1",
    sort_order: 0,
    system_type: "conventional",
    compressor_stages: 1,
    backup_heat: "electric",
    equipment_running_entity: null,
    heat_kit_confirmed: false,
    ...HP_DEFAULTS,
    ...FAN_DEFAULTS,
    ...over,
  };
}

const WING = zone({ thermostat_entity_id: "climate.wing", name: "South Wing" });
const LOOSE = zone({ thermostat_entity_id: "climate.loose", name: "", building_id: null });

function renderPage() {
  return render(
    <MemoryRouter>
      <Zones />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(zonesApi.getZones).mockResolvedValue([WING, LOOSE]);
  vi.mocked(zonesApi.getBuildings).mockResolvedValue([MAIN, DEN]);
  vi.mocked(api.getThermostats).mockResolvedValue([]);
  vi.mocked(zonesApi.getEquipmentHint).mockResolvedValue({
    system_type: null,
    auxiliary_heat: false,
    reason: null,
  });
});

/** Open the Add Zone form inside one building (or the Unassigned group). */
function openAddZone(group: string) {
  fireEvent.click(screen.getByRole("button", { name: `Add Zone to ${group}` }));
  return screen.getByRole("group", { name: "Add Zone" });
}

describe("Zones page", () => {
  it("groups zones by building with an Unassigned group and empty buildings", async () => {
    renderPage();
    expect(await screen.findByText("South Wing")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Main House" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Unassigned" })).toBeInTheDocument();
    expect(screen.getByText(/No zones in this building yet/)).toBeInTheDocument();
    // A zone with no name falls back to its entity id.
    expect(screen.getAllByText("climate.loose").length).toBe(2);
    expect(screen.getAllByText("Conventional, Electric Strips").length).toBe(2);
  });

  it("shows the empty state with no zones and no buildings", async () => {
    vi.mocked(zonesApi.getZones).mockResolvedValue([]);
    vi.mocked(zonesApi.getBuildings).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/Nothing here yet. Add a building/)).toBeInTheDocument();
    // With no building there is nowhere to add a zone: Add Building is the only way in.
    expect(screen.queryByRole("button", { name: /Add Zone/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Add Building" })).toBeInTheDocument();
  });

  it("reports a load failure", async () => {
    vi.mocked(zonesApi.getZones).mockRejectedValue(new Error("down"));
    renderPage();
    expect(await screen.findByText("Could not load zones")).toBeInTheDocument();
  });

  it("adds a building and reports a rejected one", async () => {
    vi.mocked(zonesApi.createBuilding).mockResolvedValueOnce(MAIN);
    renderPage();
    await screen.findByText("South Wing");
    fireEvent.click(screen.getByRole("button", { name: "Add Building" }));
    fireEvent.change(screen.getByLabelText("Building Name"), { target: { value: "Shop" } });
    const form = screen.getByLabelText("Building Name").closest(".add-building") as HTMLElement;
    fireEvent.click(within(form).getByRole("button", { name: "Add Building" }));
    await waitFor(() => expect(zonesApi.createBuilding).toHaveBeenCalledWith("Shop"));
    await waitFor(() => expect(screen.queryByLabelText("Building Name")).toBeNull());

    vi.mocked(zonesApi.createBuilding).mockRejectedValueOnce(
      new Error("a building with that name already exists")
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Building" }));
    const form2 = screen.getByLabelText("Building Name").closest(".add-building") as HTMLElement;
    fireEvent.click(within(form2).getByRole("button", { name: "Add Building" }));
    expect(await screen.findByText("a building with that name already exists")).toBeInTheDocument();

    vi.mocked(zonesApi.createBuilding).mockRejectedValueOnce("nope");
    fireEvent.click(within(form2).getByRole("button", { name: "Add Building" }));
    expect(await screen.findByText("Could not add the building")).toBeInTheDocument();
    fireEvent.click(within(form2).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Building Name")).toBeNull();
  });

  it("renames a building, cancels, and reports failures", async () => {
    vi.mocked(zonesApi.updateBuilding).mockResolvedValueOnce({ ...MAIN, name: "House" });
    renderPage();
    await screen.findByText("South Wing");
    fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    fireEvent.change(screen.getByLabelText("Building name"), { target: { value: "House" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: "House" })).toBeInTheDocument();
    expect(zonesApi.updateBuilding).toHaveBeenCalledWith("b1", { name: "House" });

    fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    fireEvent.change(screen.getByLabelText("Building name"), { target: { value: "Zzz" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "House" })).toBeInTheDocument();

    vi.mocked(zonesApi.updateBuilding).mockRejectedValueOnce(new Error("taken"));
    fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("taken")).toBeInTheDocument();

    vi.mocked(zonesApi.updateBuilding).mockRejectedValueOnce(42);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not rename this building")).toBeInTheDocument();
  });

  it("deletes a building after a confirmation that says what happens to its zones", async () => {
    vi.mocked(zonesApi.deleteBuilding).mockResolvedValueOnce({ deleted: "b2" });
    renderPage();
    await screen.findByText("South Wing");
    fireEvent.click(screen.getByRole("button", { name: "Delete The Den" }));
    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent(
      'Delete "The Den"? Its zones and rooms are kept and moved to Unassigned'
    );
    // Cancelling deletes nothing.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(zonesApi.deleteBuilding).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete The Den" }));
    fireEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: "Delete Building" })
    );
    await waitFor(() => expect(zonesApi.deleteBuilding).toHaveBeenCalledWith("b2"));
    await waitFor(() => expect(zonesApi.getZones).toHaveBeenCalledTimes(2));

    for (const [failure, shown] of [
      [new Error("Building not found"), "Building not found"],
      [null, "Could not delete this building"],
    ] as const) {
      vi.mocked(zonesApi.deleteBuilding).mockRejectedValueOnce(failure);
      fireEvent.click(screen.getByRole("button", { name: "Delete Main House" }));
      fireEvent.click(
        within(screen.getByTestId("confirm-dialog")).getByRole("button", {
          name: "Delete Building",
        })
      );
      expect(await screen.findByText(shown)).toBeInTheDocument();
    }
  });

  it("deletes a zone from its own header after a confirmation", async () => {
    vi.mocked(api.deleteThermostat).mockResolvedValueOnce({ deleted: "climate.wing" });
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <Zones onChanged={onChanged} />
      </MemoryRouter>
    );
    await screen.findByText("South Wing");
    fireEvent.click(screen.getByRole("button", { name: "Delete Zone South Wing" }));
    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent('Delete the zone "South Wing" and all of its rooms?');
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.deleteThermostat).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete Zone South Wing" }));
    fireEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: "Delete Zone" })
    );
    // Its rooms go with it.
    await waitFor(() => expect(api.deleteThermostat).toHaveBeenCalledWith("climate.wing", true));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    // A zone with no name is named by its thermostat; a failure is shown.
    for (const [failure, shown] of [
      [new Error("Zone not found"), "Zone not found"],
      ["nope", "Could not delete this zone"],
    ] as const) {
      vi.mocked(api.deleteThermostat).mockRejectedValueOnce(failure);
      fireEvent.click(screen.getByRole("button", { name: "Delete Zone climate.loose" }));
      const again = screen.getByTestId("confirm-dialog");
      expect(again).toHaveTextContent('Delete the zone "climate.loose"');
      fireEvent.click(within(again).getByRole("button", { name: "Delete Zone" }));
      expect(await screen.findByText(shown)).toBeInTheDocument();
    }
  });

  it("edits a zone's equipment and saves it", async () => {
    const saved = zone({
      thermostat_entity_id: "climate.wing",
      name: "South Wing",
      system_type: "heat_pump",
      compressor_stages: 2,
      backup_heat: "none",
      building_id: "b2",
    });
    vi.mocked(zonesApi.updateZone).mockResolvedValueOnce(saved);
    renderPage();
    await screen.findByText("South Wing");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit Zone" })[0]);
    const editor = screen.getByRole("region", { name: "Edit South Wing" });

    fireEvent.click(within(editor).getByRole("radio", { name: "Heat Pump" }));
    expect(within(editor).getByRole("radio", { name: "Heat Pump" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    // Heat pump + electric backup + unconfirmed → the heater-kit check shows.
    expect(within(editor).getByText(HEAT_KIT_WARNING)).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole("button", { name: "Confirmed" }));
    expect(within(editor).queryByText(HEAT_KIT_WARNING)).toBeNull();

    fireEvent.change(within(editor).getByLabelText("Compressor Stages"), {
      target: { value: "2" },
    });
    fireEvent.change(within(editor).getByLabelText("Auxiliary Heat"), {
      target: { value: "none" },
    });
    fireEvent.change(within(editor).getByLabelText("Building"), { target: { value: "b2" } });
    fireEvent.click(within(editor).getByRole("button", { name: "pick Not set" }));
    expect(within(editor).getByText("climate.wing_cloud")).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole("button", { name: "Clear" }));
    fireEvent.click(within(editor).getByRole("button", { name: "pick Not set" }));

    fireEvent.click(within(editor).getByRole("button", { name: "intake yes for South Wing" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Save Zone" }));
    await waitFor(() =>
      expect(zonesApi.updateZone).toHaveBeenCalledWith("climate.wing", {
        building_id: "b2",
        system_type: "heat_pump",
        compressor_stages: 2,
        backup_heat: "none",
        equipment_running_entity: "climate.wing_cloud",
        heat_kit_confirmed: true,
        ...HP_DEFAULTS,
        air_intake: "yes",
      })
    );
    // Saving keeps the zone open (its thermostat settings save separately),
    // now under its new building.
    await waitFor(() => expect(zonesApi.updateZone).toHaveBeenCalled());
    const moved = await screen.findByRole("region", { name: "Edit South Wing" });
    await waitFor(() => expect(within(moved).getByLabelText("Building")).toHaveValue("b2"));
    fireEvent.click(
      within(screen.getByRole("region", { name: "Edit South Wing" })).getByRole("button", {
        name: "Close",
      })
    );
    expect(await screen.findByText("Heat Pump, 2 Stage, No Auxiliary Heat")).toBeInTheDocument();
  });

  it("edits heat pump protection in display units and shows backup heat", async () => {
    const hp = zone({
      thermostat_entity_id: "climate.wing",
      name: "South Wing",
      system_type: "heat_pump",
      hp_max_step_f: 1.8,
      hp_recovery_f_per_hr: 3.6,
      hp_compressor_lockout_f: 23,
      aux_heat_running: true,
      strips_expected: true,
    });
    vi.mocked(zonesApi.getZones).mockResolvedValue([hp]);
    vi.mocked(zonesApi.updateZone).mockResolvedValueOnce(hp);
    render(
      <MemoryRouter>
        <UnitContext.Provider value={buildUnitContext("C")}>
          <Zones />
        </UnitContext.Provider>
      </MemoryRouter>
    );
    await screen.findByText("South Wing");
    expect(screen.getByRole("status")).toHaveTextContent("Auxiliary Heat Running");
    expect(screen.getByText("Strips Expected")).toHaveAttribute(
      "title",
      expect.stringContaining("below the compressor lockout")
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Zone" }));
    const editor = screen.getByRole("region", { name: "Edit South Wing" });
    expect(within(editor).getByText("Heat Pump Protection")).toBeInTheDocument();
    expect(within(editor).getByLabelText("Max Setpoint Step")).toHaveValue(1);
    expect(within(editor).getByLabelText("Max Recovery Rate")).toHaveValue(2);
    expect(within(editor).getByLabelText("Compressor Lockout Below")).toHaveValue(-5);
    expect(within(editor).getByText("°C/hr")).toBeInTheDocument();
    expect(within(editor).getAllByText("°C")).toHaveLength(2);
    expect(within(editor).getByText("%")).toBeInTheDocument();

    expect(within(editor).getByText(AUX_HEAT_EXPLAINER)).toBeInTheDocument();
    expect(within(editor).getByText(/raises the heat in small steps/)).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole("radio", { name: "Allow When Needed" }));
    expect(within(editor).getByText(/like a conventional system/)).toBeInTheDocument();
    expect(within(editor).getByLabelText("Max Setpoint Step")).toBeDisabled();
    expect(within(editor).getByLabelText("Max Recovery Rate")).toBeDisabled();
    expect(within(editor).getByLabelText("Minimum Run Time")).toBeEnabled();
    fireEvent.click(within(editor).getByRole("radio", { name: "Avoid" }));
    expect(within(editor).getByLabelText("Max Setpoint Step")).toBeEnabled();
    fireEvent.click(within(editor).getByRole("radio", { name: "Allow When Needed" }));
    fireEvent.click(within(editor).getByRole("radio", { name: "Avoid" }));
    fireEvent.click(within(editor).getByRole("radio", { name: "Allow When Needed" }));
    fireEvent.click(within(editor).getByRole("radio", { name: "Avoid" }));
    fireEvent.change(within(editor).getByLabelText("Max Setpoint Step"), {
      target: { value: "1.5" },
    });
    fireEvent.change(within(editor).getByLabelText("Minimum Run Time"), {
      target: { value: "20" },
    });
    fireEvent.change(within(editor).getByLabelText("Compressor Lockout Below"), {
      target: { value: "" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Save Zone" }));
    await waitFor(() =>
      expect(zonesApi.updateZone).toHaveBeenCalledWith(
        "climate.wing",
        expect.objectContaining({
          hp_max_step_f: 1.5,
          hp_recovery_f_per_hr: 2,
          hp_min_runtime_min: 20,
          hp_compressor_lockout_f: null,
          hp_aux_policy: "avoid",
        })
      )
    );
    // Saved in place: the editor stays open and says so.
    expect(await within(editor).findByText("Zone saved.")).toBeInTheDocument();
  });

  it("switches back to conventional, unassigns, cancels and reports save errors", async () => {
    renderPage();
    await screen.findByText("South Wing");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit Zone" })[1]);
    const editor = screen.getByRole("region", { name: "Edit climate.loose" });
    fireEvent.click(within(editor).getByRole("radio", { name: "Heat Pump" }));
    fireEvent.click(within(editor).getByRole("radio", { name: "Conventional" }));
    fireEvent.change(within(editor).getByLabelText("Building"), { target: { value: "" } });

    vi.mocked(zonesApi.updateZone).mockRejectedValueOnce(new Error("bad stage"));
    fireEvent.click(within(editor).getByRole("button", { name: "Save Zone" }));
    expect(await within(editor).findByText("bad stage")).toBeInTheDocument();
    vi.mocked(zonesApi.updateZone).mockRejectedValueOnce({});
    fireEvent.click(within(editor).getByRole("button", { name: "Save Zone" }));
    expect(await within(editor).findByText("Could not save this zone")).toBeInTheDocument();

    // A failed save shows no "saved" note.
    expect(within(editor).queryByRole("status")).toBeNull();
    fireEvent.click(within(editor).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Edit climate.loose" })).toBeNull();
  });

  it("adds a zone inside a building, asking what kind of system it is", async () => {
    vi.mocked(api.createThermostat).mockResolvedValue({} as api.ThermostatConfig);
    vi.mocked(api.createRoom).mockResolvedValue({} as api.Room);
    vi.mocked(zonesApi.updateZone).mockResolvedValue(WING);
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <Zones onChanged={onChanged} />
      </MemoryRouter>
    );
    await screen.findByText("South Wing");
    // One Add Zone per building, none at the top of the page.
    expect(screen.queryByRole("button", { name: "Add Zone" })).toBeNull();
    const form = openAddZone("The Den");
    // The empty building's placeholder gives way to the form.
    expect(screen.queryByText(/No zones in this building yet/)).toBeNull();
    expect(within(form).getByText(/A zone in The Den:/)).toBeInTheDocument();
    // The building is where the button was pressed; the form does not ask again.
    expect(within(form).queryByLabelText("Building")).toBeNull();
    const submit = within(form).getByRole("button", { name: "Add Zone" });
    expect(submit).toBeDisabled();

    fireEvent.click(within(form).getByRole("button", { name: "pick Search thermostats…" }));
    expect(within(form).getByText("climate.wing_cloud")).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Change" }));
    fireEvent.click(within(form).getByRole("button", { name: "pick Search thermostats…" }));
    fireEvent.change(within(form).getByLabelText("Zone Name"), { target: { value: " Shop " } });
    expect(submit).toBeDisabled();
    // The vent count is required, and must be a whole number of at least one.
    expect(submit).toBeDisabled();
    for (const bad of ["0", "2.5", "-3", "abc"]) {
      fireEvent.change(within(form).getByLabelText("Total Vent Count"), { target: { value: bad } });
      expect(submit).toBeDisabled();
    }
    fireEvent.change(within(form).getByLabelText("Total Vent Count"), { target: { value: "8" } });
    expect(
      within(form).getByText(/Count every register this thermostat serves/)
    ).toBeInTheDocument();

    // Everything else is filled in, but the kind of system is never assumed.
    expect(submit).toBeDisabled();
    expect(within(form).getByText(/Choose the kind of system/)).toBeInTheDocument();
    expect(within(form).queryByRole("status")).toBeNull();
    fireEvent.click(within(form).getByRole("radio", { name: "Conventional" }));
    // Its heat is asked for too: electric strips is not a safe guess.
    expect(submit).toBeDisabled();
    expect(within(form).getByText(/Choose the kind of system and its heat/)).toBeInTheDocument();
    expect(within(form).getByLabelText("Heat")).toHaveValue("");
    // A conventional system's heat is named for what it is.
    expect(within(form).getByRole("option", { name: "Gas Furnace" })).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Heat"), { target: { value: "gas" } });
    expect(within(form).queryByText(/Choose the kind of system/)).toBeNull();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(api.createThermostat).toHaveBeenCalledWith({
        thermostat_entity_id: "climate.wing_cloud",
        name: "Shop",
        total_vents_count: 8,
      })
    );
    // No room is made with it: rooms are added inside the zone afterwards.
    expect(within(form).queryByLabelText("First Room")).toBeNull();
    expect(api.createRoom).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(zonesApi.updateZone).toHaveBeenCalledWith("climate.wing_cloud", {
        system_type: "conventional",
        compressor_stages: 1,
        backup_heat: "gas",
        building_id: "b2",
      })
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Add Zone" })).toBeNull();
  });

  it("suggests a heat pump when Home Assistant shows the signs of one", async () => {
    vi.mocked(api.createThermostat).mockResolvedValue({} as api.ThermostatConfig);
    vi.mocked(api.createRoom).mockResolvedValue({} as api.Room);
    vi.mocked(zonesApi.updateZone).mockResolvedValue(WING);
    vi.mocked(zonesApi.getEquipmentHint).mockResolvedValue({
      system_type: "heat_pump",
      auxiliary_heat: true,
      reason: "aux_switch",
    });
    renderPage();
    await screen.findByText("South Wing");
    const form = openAddZone("Main House");
    fireEvent.click(within(form).getByRole("button", { name: "pick Search thermostats…" }));
    expect(zonesApi.getEquipmentHint).toHaveBeenCalledWith("climate.wing_cloud");
    const hint = await within(form).findByRole("status");
    expect(hint).toHaveTextContent(
      "This looks like a heat pump with auxiliary heat. Is that right?"
    );
    // A suggestion, not a choice: nothing is selected for the user.
    expect(within(form).getByRole("radio", { name: "Heat Pump" })).not.toBeChecked();
    // Saying it is conventional keeps the suggestion in view.
    fireEvent.click(within(form).getByRole("radio", { name: "Conventional" }));
    expect(within(form).getByRole("status")).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Yes, Heat Pump" }));
    expect(within(form).getByRole("radio", { name: "Heat Pump" })).toBeChecked();
    expect(within(form).queryByRole("status")).toBeNull();

    fireEvent.change(within(form).getByLabelText("Zone Name"), { target: { value: "Wing" } });
    fireEvent.change(within(form).getByLabelText("Total Vent Count"), { target: { value: "9" } });
    fireEvent.change(within(form).getByLabelText("Compressor Stages"), { target: { value: "2" } });
    expect(within(form).getByRole("option", { name: "Gas (Dual Fuel)" })).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Auxiliary Heat"), {
      target: { value: "electric" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add Zone" }));
    await waitFor(() =>
      expect(zonesApi.updateZone).toHaveBeenCalledWith("climate.wing_cloud", {
        system_type: "heat_pump",
        compressor_stages: 2,
        backup_heat: "electric",
        building_id: "b1",
      })
    );
  });

  it("words the suggestion without auxiliary heat, and survives a hint that cannot be read", async () => {
    vi.mocked(zonesApi.getEquipmentHint).mockResolvedValueOnce({
      system_type: "heat_pump",
      auxiliary_heat: false,
      reason: "equipment_running",
    });
    renderPage();
    await screen.findByText("South Wing");
    const form = openAddZone("Main House");
    fireEvent.click(within(form).getByRole("button", { name: "pick Search thermostats…" }));
    expect(await within(form).findByRole("status")).toHaveTextContent(
      "This looks like a heat pump. Is that right?"
    );
    // Picking again while the first answer is gone leaves no stale suggestion.
    vi.mocked(zonesApi.getEquipmentHint).mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(within(form).getByRole("button", { name: "Change" }));
    expect(within(form).queryByRole("status")).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "pick Search thermostats…" }));
    await waitFor(() => expect(zonesApi.getEquipmentHint).toHaveBeenCalledTimes(2));
    expect(within(form).queryByRole("status")).toBeNull();
  });

  it("flags a conventional zone whose thermostat looks like a heat pump", async () => {
    vi.mocked(zonesApi.getZones).mockResolvedValue([
      { ...WING, looks_like_heat_pump: true },
      LOOSE,
    ]);
    renderPage();
    const wing = await screen.findByRole("region", { name: "South Wing" });
    const loose = screen.getByRole("region", { name: "climate.loose" });
    expect(within(loose).queryByText(/Looks Like a Heat Pump/)).toBeNull();
    // The mark is the way in to fixing it.
    fireEvent.click(
      within(wing).getByRole("button", {
        name: "South Wing looks like a heat pump. Check its system type",
      })
    );
    expect(screen.getByRole("region", { name: "Edit South Wing" })).toBeInTheDocument();
  });

  it("reports a zone that could not be added, and adds one with no building", async () => {
    vi.mocked(zonesApi.updateZone).mockResolvedValue(LOOSE);
    renderPage();
    await screen.findByText("South Wing");
    const form = openAddZone("Unassigned");
    expect(within(form).getByText(/^A zone is one thermostat/)).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "pick Search thermostats…" }));
    fireEvent.change(within(form).getByLabelText("Zone Name"), { target: { value: "Shop" } });
    fireEvent.change(within(form).getByLabelText("Total Vent Count"), { target: { value: "6" } });
    fireEvent.click(within(form).getByRole("radio", { name: "Conventional" }));
    fireEvent.change(within(form).getByLabelText("Heat"), { target: { value: "electric" } });

    vi.mocked(api.createThermostat).mockRejectedValueOnce(new Error("That thermostat is gone"));
    fireEvent.click(within(form).getByRole("button", { name: "Add Zone" }));
    expect(await within(form).findByText("That thermostat is gone")).toBeInTheDocument();
    expect(zonesApi.updateZone).not.toHaveBeenCalled();

    vi.mocked(api.createThermostat).mockRejectedValueOnce("nope");
    fireEvent.click(within(form).getByRole("button", { name: "Add Zone" }));
    expect(await within(form).findByText("Could not add the zone")).toBeInTheDocument();

    // In the Unassigned group the zone is added with no building.
    vi.mocked(api.createThermostat).mockResolvedValue({} as api.ThermostatConfig);
    fireEvent.click(within(form).getByRole("button", { name: "Add Zone" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add Zone" })).toBeNull());
    expect(zonesApi.updateZone).toHaveBeenCalledWith("climate.wing_cloud", {
      system_type: "conventional",
      compressor_stages: 1,
      backup_heat: "electric",
    });
    // Nothing is undone or created on the side.
    expect(api.deleteThermostat).not.toHaveBeenCalled();
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("cancels adding a zone", async () => {
    renderPage();
    await screen.findByText("South Wing");
    const form = openAddZone("Main House");

    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Add Zone" })).toBeNull();
  });

  it("puts thermostat settings inside the zone being edited", async () => {
    const onChanged = vi.fn();
    vi.mocked(api.getThermostats).mockResolvedValue([
      { thermostat_entity_id: "climate.wing", name: "Wing Stat" } as api.ThermostatConfig,
      { thermostat_entity_id: "climate.loose", name: "Loose Stat" } as api.ThermostatConfig,
    ]);
    render(
      <MemoryRouter>
        <Zones onChanged={onChanged} />
      </MemoryRouter>
    );
    await screen.findByText("South Wing");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit Zone" })[0]);
    // One dialog, opening on the equipment; the thermostat is its other tab.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("tab", { name: "Equipment" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(within(dialog).getByRole("tabpanel", { name: "Equipment" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("tabpanel", { name: "Thermostat" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Thermostat" }));
    expect(within(dialog).queryByRole("tabpanel", { name: "Equipment" })).toBeNull();
    expect(screen.getByText("card Wing Stat")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Equipment" }));
    fireEvent.click(within(dialog).getByRole("tab", { name: "Thermostat" }));

    fireEvent.click(screen.getByRole("button", { name: "stub save" }));
    expect(screen.getByText("card Renamed")).toBeInTheDocument();
    // The zone takes its name from the thermostat, so its heading follows.
    expect(screen.getByRole("region", { name: "Renamed" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "climate.loose" })).toBeInTheDocument();

    // Deleting the zone closes its editor and tells the page to reload.
    fireEvent.click(screen.getByRole("button", { name: "stub delete" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(zonesApi.getZones).toHaveBeenCalledTimes(2);

    // The other zone's settings were untouched by the save above.
    fireEvent.click(screen.getAllByRole("button", { name: "Edit Zone" })[1]);
    expect(screen.getByRole("region", { name: "Edit climate.loose" })).toBeInTheDocument();
    expect(screen.getByText("card Loose Stat")).toBeInTheDocument();
    // Close, or a click outside the sheet, puts the page back.
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows only the equipment for a zone whose thermostat settings did not load", async () => {
    renderPage();
    await screen.findByText("South Wing");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit Zone" })[0]);
    expect(screen.getByRole("region", { name: "Edit South Wing" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Thermostat Settings" })).toBeNull();
  });

  it("renders each zone's rooms, its Add Room button, a custom title, and reloads on demand", async () => {
    const onAddRoom = vi.fn();
    const view = render(
      <MemoryRouter>
        <Zones
          title="Structure"
          subtitle="Everything in the house."
          onAddRoom={onAddRoom}
          renderRooms={(id) => <p>rooms of {id}</p>}
          reloadKey={0}
        />
      </MemoryRouter>
    );
    expect(await screen.findByText("rooms of climate.wing")).toBeInTheDocument();
    expect(screen.getByText("rooms of climate.loose")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Structure" })).toBeInTheDocument();
    expect(screen.getByText("Everything in the house.")).toBeInTheDocument();
    // Add Room lives in each zone, and says which zone the room is for.
    fireEvent.click(screen.getByRole("button", { name: "Add Room to South Wing" }));
    expect(onAddRoom).toHaveBeenCalledWith("climate.wing");
    fireEvent.click(screen.getByRole("button", { name: "Add Room to climate.loose" }));
    expect(onAddRoom).toHaveBeenLastCalledWith("climate.loose");
    expect(screen.getByRole("region", { name: "South Wing" })).toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <Zones renderRooms={(id) => <p>rooms of {id}</p>} reloadKey={1} />
      </MemoryRouter>
    );
    await waitFor(() => expect(zonesApi.getZones).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "My Home" })).toBeInTheDocument();
    // Without a room form to open there is no Add Room button.
    expect(screen.queryByRole("button", { name: /Add Room/ })).toBeNull();
  });

  it("will not add a thermostat that is already a zone", async () => {
    vi.mocked(zonesApi.getZones).mockResolvedValue([
      zone({ thermostat_entity_id: "climate.wing_cloud", name: "Cloud Wing" }),
    ]);
    renderPage();
    await screen.findByText("Cloud Wing");
    const form = openAddZone("Main House");
    fireEvent.click(within(form).getByRole("button", { name: "pick Search thermostats…" }));
    fireEvent.change(within(form).getByLabelText("Zone Name"), { target: { value: "Again" } });
    fireEvent.change(within(form).getByLabelText("Total Vent Count"), { target: { value: "4" } });
    fireEvent.click(within(form).getByRole("radio", { name: "Conventional" }));
    expect(
      within(form).getByText("That thermostat is already a zone. Use Add Room to add a room to it.")
    ).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Add Zone" })).toBeDisabled();
    expect(api.createThermostat).not.toHaveBeenCalled();
  });

  it("keeps a new zone whose building and system could not be saved, and says so", async () => {
    vi.mocked(api.createThermostat).mockResolvedValue({} as api.ThermostatConfig);
    vi.mocked(api.createRoom).mockResolvedValue({} as api.Room);
    vi.mocked(zonesApi.updateZone).mockRejectedValueOnce(new Error("no such building"));
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <Zones onChanged={onChanged} />
      </MemoryRouter>
    );
    await screen.findByText("South Wing");
    const form = openAddZone("The Den");
    fireEvent.click(within(form).getByRole("button", { name: "pick Search thermostats…" }));
    fireEvent.change(within(form).getByLabelText("Zone Name"), { target: { value: "Shop" } });
    fireEvent.change(within(form).getByLabelText("Total Vent Count"), { target: { value: "4" } });
    fireEvent.click(within(form).getByRole("radio", { name: "Heat Pump" }));
    fireEvent.change(within(form).getByLabelText("Auxiliary Heat"), { target: { value: "none" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add Zone" }));

    expect(
      await screen.findByText(
        "The zone was added, but its building and kind of system could not be saved. Edit the zone to set them."
      )
    ).toBeInTheDocument();
    // The form closed and the list was reloaded; nothing was rolled back.
    expect(screen.queryByRole("group", { name: "Add Zone" })).toBeNull();
    expect(onChanged).toHaveBeenCalled();
    expect(api.deleteThermostat).not.toHaveBeenCalled();
  });
});
