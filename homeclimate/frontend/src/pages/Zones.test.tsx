import { HP_DEFAULTS } from "../zoneFixtures";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as zonesApi from "../zonesApi";
import { UnitContext, buildUnitContext } from "../contexts";
import Zones, { HEAT_KIT_WARNING } from "./Zones";

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
  };
});

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
});

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
    expect(await screen.findByText(/No zones yet/)).toBeInTheDocument();
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

  it("deletes a building and reports a refusal", async () => {
    vi.mocked(zonesApi.deleteBuilding).mockResolvedValueOnce({ deleted: "b2" });
    renderPage();
    await screen.findByText("South Wing");
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    await waitFor(() => expect(zonesApi.deleteBuilding).toHaveBeenCalledWith("b2"));
    await waitFor(() => expect(zonesApi.getZones).toHaveBeenCalledTimes(2));

    vi.mocked(zonesApi.deleteBuilding).mockRejectedValueOnce(
      new Error("Move this building's zones to another building first")
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    expect(
      await screen.findByText("Move this building's zones to another building first")
    ).toBeInTheDocument();

    vi.mocked(zonesApi.deleteBuilding).mockRejectedValueOnce(null);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    expect(await screen.findByText("Could not delete this building")).toBeInTheDocument();
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
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
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
    fireEvent.change(within(editor).getByLabelText("Backup Heat"), { target: { value: "none" } });
    fireEvent.change(within(editor).getByLabelText("Building"), { target: { value: "b2" } });
    fireEvent.click(within(editor).getByRole("button", { name: "pick Not set" }));
    expect(within(editor).getByText("climate.wing_cloud")).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole("button", { name: "Clear" }));
    fireEvent.click(within(editor).getByRole("button", { name: "pick Not set" }));

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
      })
    );
    expect(await screen.findByText("Heat Pump, 2 Stage, No Backup Heat")).toBeInTheDocument();
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
    expect(screen.getByRole("status")).toHaveTextContent("Backup Heat Running");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("region", { name: "Edit South Wing" });
    expect(within(editor).getByText("Heat Pump Protection")).toBeInTheDocument();
    expect(within(editor).getByLabelText("Max Setpoint Step")).toHaveValue(1);
    expect(within(editor).getByLabelText("Max Recovery Rate")).toHaveValue(2);
    expect(within(editor).getByLabelText("Compressor Lockout Below")).toHaveValue(-5);
    expect(within(editor).getByText("°C/hr")).toBeInTheDocument();
    expect(within(editor).getAllByText("°C")).toHaveLength(2);
    expect(within(editor).getByText("%")).toBeInTheDocument();

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
        })
      )
    );
  });

  it("switches back to conventional, unassigns, cancels and reports save errors", async () => {
    renderPage();
    await screen.findByText("South Wing");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
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

    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Edit climate.loose" })).toBeNull();
  });
});
