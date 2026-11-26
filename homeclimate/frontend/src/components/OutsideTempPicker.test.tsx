import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OutsideTempPicker from "./OutsideTempPicker";
import { UnitContext, buildUnitContext } from "../contexts";
import * as api from "../api";

vi.mock("../api");

function renderPicker(unit: "F" | "C" = "F", onChange?: (id: string | null) => void) {
  return render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <OutsideTempPicker onChange={onChange} />
    </UnitContext.Provider>
  );
}

describe("OutsideTempPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getHAEntities).mockResolvedValue([
      { entity_id: "sensor.outdoor", state: "50", friendly_name: "Outdoor Sensor" },
    ]);
  });

  it("shows the configured entity with its formatted reading and fires onChange on load", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 50,
    });
    const onChange = vi.fn();
    renderPicker("F", onChange);
    expect(await screen.findByText(/sensor\.outdoor/)).toBeInTheDocument();
    // EntityState-style value is °F; fmtTemp renders it with the unit label.
    expect(screen.getByText(/50\.0°F/)).toBeInTheDocument();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("sensor.outdoor"));
  });

  it("converts the current reading for display in Celsius mode", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 50, // °F from the backend — display should be 10°C
    });
    renderPicker("C");
    expect(await screen.findByText(/10\.0°C/)).toBeInTheDocument();
  });

  it("shows the none-configured placeholder when no entity is set", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: null,
      current_value: null,
    });
    renderPicker();
    expect(await screen.findByText(/None configured/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  it("saves a selection made through the entity picker", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: null,
      current_value: null,
    });
    vi.mocked(api.setOutsideTempEntities).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 41,
    });
    const onChange = vi.fn();
    renderPicker("F", onChange);
    await screen.findByText(/None configured/);

    fireEvent.focus(screen.getByRole("textbox"));
    fireEvent.mouseDown(await screen.findByText("Outdoor Sensor"));

    await waitFor(() =>
      expect(api.setOutsideTempEntities).toHaveBeenCalledWith(["sensor.outdoor"])
    );
    expect(await screen.findByText(/sensor\.outdoor/)).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith("sensor.outdoor");
  });

  it("removes the configured sensor via its Remove button", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 50,
    });
    vi.mocked(api.setOutsideTempEntities).mockResolvedValue({
      entity_id: null,
      current_value: null,
    });
    const onChange = vi.fn();
    renderPicker("F", onChange);

    fireEvent.click(await screen.findByRole("button", { name: "Remove sensor.outdoor" }));
    await waitFor(() => expect(api.setOutsideTempEntities).toHaveBeenCalledWith([]));
    expect(await screen.findByText(/None configured/)).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("surfaces a load failure as an error badge", async () => {
    vi.mocked(api.getOutsideTempEntity).mockRejectedValue(new Error("boom on load"));
    renderPicker();
    expect(await screen.findByText("boom on load")).toBeInTheDocument();
  });

  it("surfaces a save failure and keeps the previous entity", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 50,
    });
    vi.mocked(api.setOutsideTempEntities).mockRejectedValue(new Error("save exploded"));
    renderPicker();

    fireEvent.click(await screen.findByRole("button", { name: "Remove sensor.outdoor" }));
    expect(await screen.findByText("save exploded")).toBeInTheDocument();
    expect(screen.getByText(/sensor\.outdoor/)).toBeInTheDocument();
  });

  it("recovers from a load error once a save succeeds (#497)", async () => {
    vi.mocked(api.getOutsideTempEntity).mockRejectedValue(new Error("boom on load"));
    vi.mocked(api.setOutsideTempEntities).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 94,
    });
    renderPicker();
    expect(await screen.findByText("boom on load")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Search/i), {
      target: { value: "outdoor" },
    });
    fireEvent.mouseDown(await screen.findByText(/Outdoor Sensor/));
    expect(await screen.findByText(/94\.0°F/)).toBeInTheDocument();
    expect(screen.queryByText("boom on load")).toBeNull();
  });
  it("adds a second sensor and shows each reading and the average", async () => {
    vi.mocked(api.getHAEntities).mockResolvedValue([
      { entity_id: "sensor.north", state: "60", friendly_name: "North Porch" },
      { entity_id: "sensor.south", state: "70", friendly_name: "South Wall" },
    ]);
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.north",
      entity_ids: ["sensor.north"],
      current_value: 60,
      values: { "sensor.north": 60 },
    });
    vi.mocked(api.setOutsideTempEntities).mockResolvedValue({
      entity_id: "sensor.north",
      entity_ids: ["sensor.north", "sensor.south"],
      current_value: 65,
      values: { "sensor.north": 60, "sensor.south": 70 },
    });
    renderPicker();
    expect(await screen.findByText("sensor.north · 60.0°F")).toBeInTheDocument();
    expect(screen.queryByText(/Average of/)).not.toBeInTheDocument();

    fireEvent.focus(screen.getByPlaceholderText(/Add another sensor/));
    fireEvent.mouseDown(await screen.findByText("South Wall"));
    await waitFor(() =>
      expect(api.setOutsideTempEntities).toHaveBeenCalledWith(["sensor.north", "sensor.south"])
    );
    expect(await screen.findByText("sensor.south · 70.0°F")).toBeInTheDocument();
    expect(screen.getByText("Average of 2 sensors: 65.0°F")).toBeInTheDocument();
  });

  it("does not save a sensor that is already in the list", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      entity_ids: ["sensor.outdoor"],
      current_value: 50,
      values: { "sensor.outdoor": 50 },
    });
    renderPicker();
    await screen.findByText("sensor.outdoor · 50.0°F");
    fireEvent.focus(screen.getByRole("textbox"));
    fireEvent.mouseDown(await screen.findByText("Outdoor Sensor"));
    expect(api.setOutsideTempEntities).not.toHaveBeenCalled();
  });

  it("says so when a sensor, or every sensor, has no reading", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.north",
      entity_ids: ["sensor.north", "sensor.south"],
      current_value: null,
      values: { "sensor.north": null },
    });
    renderPicker();
    expect(await screen.findByText("sensor.north · no reading")).toBeInTheDocument();
    // A sensor the backend sent no reading for at all reads the same way.
    expect(screen.getByText("sensor.south · no reading")).toBeInTheDocument();
    expect(screen.getByText("Average of 2 sensors: no reading right now")).toBeInTheDocument();
  });

  it("removes one sensor of several and keeps the rest", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.north",
      entity_ids: ["sensor.north", "sensor.south"],
      current_value: 65,
      values: { "sensor.north": 60, "sensor.south": 70 },
    });
    vi.mocked(api.setOutsideTempEntities).mockResolvedValue({
      entity_id: "sensor.south",
      entity_ids: ["sensor.south"],
      current_value: 70,
      values: { "sensor.south": 70 },
    });
    const onChange = vi.fn();
    renderPicker("F", onChange);
    fireEvent.click(await screen.findByRole("button", { name: "Remove sensor.north" }));
    await waitFor(() => expect(api.setOutsideTempEntities).toHaveBeenCalledWith(["sensor.south"]));
    expect(onChange).toHaveBeenLastCalledWith("sensor.south");
    await waitFor(() => expect(screen.queryByText(/Average of/)).not.toBeInTheDocument());
  });
});
