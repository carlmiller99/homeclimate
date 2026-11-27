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

const pickNew = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Add Sensor" }));
  fireEvent.focus(screen.getByRole("textbox"));
  fireEvent.mouseDown(await screen.findByText(name));
};

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
    // By its friendly name; the entity ID only on hover.
    const chip = await screen.findByTitle("sensor.outdoor");
    expect(chip).toHaveTextContent("Outdoor50.0°F");
    expect(screen.queryByText(/sensor\.outdoor/)).not.toBeInTheDocument();
    expect(screen.getByText("From 1 sensor")).toBeInTheDocument();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("sensor.outdoor"));
  });

  it("converts the current reading for display in Celsius mode", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      current_value: 50, // °F from the backend — display should be 10°C
    });
    renderPicker("C");
    expect(await screen.findByTitle("sensor.outdoor")).toHaveTextContent("10.0°C");
  });

  it("shows the none-configured placeholder when no entity is set", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: null,
      current_value: null,
    });
    renderPicker();
    expect(await screen.findByText("No sensor yet. Eco Mode needs one.")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
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
    await screen.findByText(/^No sensor yet/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Sensor" })).toBeEnabled());
    await pickNew("Outdoor Sensor");

    await waitFor(() =>
      expect(api.setOutsideTempEntities).toHaveBeenCalledWith(["sensor.outdoor"])
    );
    expect(await screen.findByTitle("sensor.outdoor")).toBeInTheDocument();
    // Add Sensor can be backed out of.
    fireEvent.click(screen.getByRole("button", { name: "Add Sensor" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The search box goes away again once something is picked.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("button", { name: "Remove Outdoor" }));
    await waitFor(() => expect(api.setOutsideTempEntities).toHaveBeenCalledWith([]));
    expect(await screen.findByText(/^No sensor yet/)).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("button", { name: "Remove Outdoor" }));
    expect(await screen.findByText("save exploded")).toBeInTheDocument();
    expect(screen.getByTitle("sensor.outdoor")).toBeInTheDocument();
  });

  it("after a failed load, waits for Try Again before it will add a sensor (#497)", async () => {
    vi.mocked(api.getOutsideTempEntity).mockRejectedValueOnce(new Error("boom on load"));
    vi.mocked(api.setOutsideTempEntities).mockResolvedValue({
      entity_id: "sensor.north",
      entity_ids: ["sensor.north", "sensor.outdoor"],
      current_value: 94,
      values: { "sensor.north": 90, "sensor.outdoor": 98 },
    });
    renderPicker();
    expect(await screen.findByText("boom on load")).toBeInTheDocument();

    // The list on the server is unknown, so nothing can be added to it yet.
    expect(screen.getByRole("button", { name: "Add Sensor" })).toBeDisabled();

    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.north",
      entity_ids: ["sensor.north"],
      current_value: 90,
      values: { "sensor.north": 90 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByTitle("sensor.north")).toHaveTextContent("North90.0°F");
    expect(screen.queryByText("boom on load")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try Again" })).toBeNull();

    await pickNew("Outdoor Sensor");
    await waitFor(() =>
      expect(api.setOutsideTempEntities).toHaveBeenCalledWith(["sensor.north", "sensor.outdoor"])
    );
    expect(await screen.findByText("Average of 2 sensors")).toBeInTheDocument();
    expect(screen.getByText("94.0°F")).toBeInTheDocument();
  });

  it("ignores a second pick while a save is still in flight", async () => {
    vi.mocked(api.getHAEntities).mockResolvedValue([
      { entity_id: "sensor.north", state: "60", friendly_name: "North Porch" },
      { entity_id: "sensor.south", state: "70", friendly_name: "South Wall" },
    ]);
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: null,
      entity_ids: [],
      current_value: null,
      values: {},
    });
    let finish: (v: api.OutsideTempEntitySetting) => void = () => {};
    vi.mocked(api.setOutsideTempEntities).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    renderPicker();
    await screen.findByText(/^No sensor yet/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Sensor" })).toBeEnabled());
    await pickNew("North Porch");
    // Nothing more can be added until that one is saved.
    expect(screen.getByRole("button", { name: "Add Sensor" })).toBeDisabled();
    expect(api.setOutsideTempEntities).toHaveBeenCalledTimes(1);
    expect(api.setOutsideTempEntities).toHaveBeenCalledWith(["sensor.north"]);
    finish({
      entity_id: "sensor.north",
      entity_ids: ["sensor.north"],
      current_value: 60,
      values: { "sensor.north": 60 },
    });
    expect(await screen.findByTitle("sensor.north")).toHaveTextContent("North60.0°F");
    expect(screen.getByRole("button", { name: "Add Sensor" })).toBeEnabled();
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
    expect(await screen.findByTitle("sensor.north")).toHaveTextContent("North60.0°F");
    expect(screen.queryByText(/Average of/)).not.toBeInTheDocument();

    await pickNew("South Wall");
    await waitFor(() =>
      expect(api.setOutsideTempEntities).toHaveBeenCalledWith(["sensor.north", "sensor.south"])
    );
    expect(await screen.findByTitle("sensor.south")).toHaveTextContent("South70.0°F");
    expect(screen.getByText("Average of 2 sensors")).toBeInTheDocument();
    expect(screen.getByText("65.0°F")).toBeInTheDocument();
  });

  it("does not save a sensor that is already in the list", async () => {
    vi.mocked(api.getOutsideTempEntity).mockResolvedValue({
      entity_id: "sensor.outdoor",
      entity_ids: ["sensor.outdoor"],
      current_value: 50,
      values: { "sensor.outdoor": 50 },
    });
    renderPicker();
    await screen.findByTitle("sensor.outdoor");
    await pickNew("Outdoor Sensor");
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
    expect(await screen.findByTitle("sensor.north")).toHaveTextContent("NorthNo reading");
    // A sensor the backend sent no reading for at all reads the same way.
    expect(screen.getByTitle("sensor.south")).toHaveTextContent("SouthNo reading");
    expect(screen.getByText("Average of 2 sensors")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Remove North" }));
    await waitFor(() => expect(api.setOutsideTempEntities).toHaveBeenCalledWith(["sensor.south"]));
    expect(onChange).toHaveBeenLastCalledWith("sensor.south");
    await waitFor(() => expect(screen.queryByText(/Average of/)).not.toBeInTheDocument());
  });
});
