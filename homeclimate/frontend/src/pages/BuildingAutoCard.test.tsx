import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import BuildingAutoCard from "./BuildingAutoCard";
import * as bm from "../buildingModeApi";
import { buildUnitContext, UnitContext } from "../contexts";

vi.mock("../buildingModeApi", async (orig) => ({
  ...(await orig<typeof import("../buildingModeApi")>()),
  getBuildingModes: vi.fn(),
  setBuildingMode: vi.fn(),
}));

const MAIN: bm.BuildingMode = {
  building_id: "b1",
  name: "Main House",
  mode: "auto",
  auto_level: "off",
  switching: "often",
  switch_threshold: 3,
  side: null,
  obey: false,
  note: "",
  waiting: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bm.getBuildingModes).mockResolvedValue([MAIN]);
  vi.mocked(bm.setBuildingMode).mockImplementation(async (_id, patch) => [{ ...MAIN, ...patch }]);
});

describe("Smart Control → Auto Mode", () => {
  const pick = (group: string, name: string) =>
    within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

  it("shows each building's level and changes it", async () => {
    render(<BuildingAutoCard />);
    expect(screen.getByText("Loading the buildings…")).toBeInTheDocument();
    await screen.findByRole("radiogroup", { name: "In Auto, Main House" });
    expect(pick("In Auto, Main House", "Each Zone Decides")).toBeChecked();
    expect(
      screen.getByText(/^Each zone heats or cools whenever its own rooms need it/)
    ).toBeInTheDocument();
    // Left to its zones, a building has no use for the rest.
    expect(screen.queryByRole("radiogroup", { name: /may switch/ })).not.toBeInTheDocument();
    // Picking what is already picked asks for nothing.
    fireEvent.click(pick("In Auto, Main House", "Each Zone Decides"));
    expect(bm.setBuildingMode).not.toHaveBeenCalled();
    fireEvent.click(pick("In Auto, Main House", "Try It First"));
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { auto_level: "watch" })
    );
    await waitFor(() => expect(pick("In Auto, Main House", "Try It First")).toBeChecked());
    expect(
      screen.getByText(/the log shows what the building would have done as one/)
    ).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: /may switch/ })).toBeInTheDocument();
  });

  it("chooses how often Auto may change sides, with the real choices", async () => {
    vi.mocked(bm.getBuildingModes).mockResolvedValue([{ ...MAIN, auto_level: "on" }]);
    vi.mocked(bm.setBuildingMode).mockImplementation(async (_id, patch) => [
      { ...MAIN, auto_level: "on", ...patch },
    ]);
    render(<BuildingAutoCard />);
    const group = await screen.findByRole("radiogroup", {
      name: "How often Main House may switch",
    });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.textContent)
    ).toEqual(["Several Times a Day", "Once a Day", "Once a Week", "Once a Month"]);
    expect(within(group).getByRole("radio", { name: "Several Times a Day" })).toBeChecked();
    // The chosen one is explained; the others on hover.
    expect(screen.getByText(/no more than twice a day/)).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: "Once a Week" })).toHaveAttribute(
      "title",
      expect.stringContaining("7 days")
    );
    fireEvent.click(within(group).getByRole("radio", { name: "Once a Month" }));
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { switching: "monthly" })
    );
    expect(await screen.findByText(/^Once in any 30 days/)).toBeInTheDocument();
  });

  it("saves the switching threshold as typed, inside its limits", async () => {
    vi.mocked(bm.getBuildingModes).mockResolvedValue([{ ...MAIN, auto_level: "on" }]);
    vi.mocked(bm.setBuildingMode).mockImplementation(async (_id, patch) => [
      { ...MAIN, auto_level: "on", ...patch },
    ]);
    render(<BuildingAutoCard />);
    const field = await screen.findByLabelText("Switching threshold for Main House (°F)");
    expect(field).toHaveValue(3);
    expect(field).toHaveAttribute("title", "Between 0 and 10°F.");
    // Leaving it as it was, or with something it cannot be, saves nothing.
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: "11" } });
    fireEvent.blur(field);
    expect(field).toHaveValue(3);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveValue(3);
    expect(bm.setBuildingMode).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "4.5" } });
    fireEvent.keyDown(field, { key: "a" });
    expect(bm.setBuildingMode).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { switch_threshold: 4.5 })
    );
    await waitFor(() => expect(field).toBeEnabled());
    expect(field).toHaveValue(4.5);
  });

  it("shows and sends the threshold in Celsius without converting it", async () => {
    // The backend converts: 2 °C typed is stored as 3.6 °F and comes back as that.
    vi.mocked(bm.getBuildingModes).mockResolvedValue([{ ...MAIN, auto_level: "on" }]);
    vi.mocked(bm.setBuildingMode).mockResolvedValue([
      { ...MAIN, auto_level: "on", switch_threshold: 3.6 },
    ]);
    render(
      <UnitContext.Provider value={buildUnitContext("C")}>
        <BuildingAutoCard />
      </UnitContext.Provider>
    );
    const field = await screen.findByLabelText("Switching threshold for Main House (°C)");
    expect(field).toHaveValue(1.67);
    expect(field).toHaveAttribute("title", "Between 0 and 5.55°C.");
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { switch_threshold: 2 })
    );
    await waitFor(() => expect(field).toHaveValue(2));
  });

  it("says when a fixed mode means Auto is not in use", async () => {
    vi.mocked(bm.getBuildingModes).mockResolvedValue([{ ...MAIN, mode: "heat_only" }]);
    render(<BuildingAutoCard />);
    expect(await screen.findByText(/^Not set to Auto on the Dashboard/)).toBeInTheDocument();
  });

  it("reports a refused change and keeps what is stored", async () => {
    render(<BuildingAutoCard />);
    await screen.findByRole("radiogroup", { name: "In Auto, Main House" });
    vi.mocked(bm.setBuildingMode).mockRejectedValueOnce(new Error("Building not found"));
    fireEvent.click(pick("In Auto, Main House", "Heats or Cools as One"));
    expect(await screen.findByText("Building not found")).toBeInTheDocument();
    expect(pick("In Auto, Main House", "Each Zone Decides")).toBeChecked();
    vi.mocked(bm.setBuildingMode).mockRejectedValueOnce("x");
    fireEvent.click(pick("In Auto, Main House", "Heats or Cools as One"));
    expect(await screen.findByText("Could not save")).toBeInTheDocument();
  });

  it("says what to do with no buildings, and when it cannot load", async () => {
    vi.mocked(bm.getBuildingModes).mockResolvedValueOnce([]);
    const { unmount } = render(<BuildingAutoCard />);
    expect(await screen.findByText(/Add a building in My Home/)).toBeInTheDocument();
    unmount();
    vi.mocked(bm.getBuildingModes).mockRejectedValue(new Error("down"));
    render(
      <StrictMode>
        <BuildingAutoCard />
      </StrictMode>
    );
    expect(await screen.findByText("Could not load the buildings.")).toBeInTheDocument();
  });

  it("ignores a response that lands after it has gone", async () => {
    let finish: (b: bm.BuildingMode[]) => void = () => {};
    vi.mocked(bm.getBuildingModes).mockReturnValueOnce(new Promise((r) => (finish = r)));
    const { unmount } = render(<BuildingAutoCard />);
    unmount();
    finish([MAIN]);
    let fail: (e: Error) => void = () => {};
    vi.mocked(bm.getBuildingModes).mockReturnValueOnce(new Promise((_r, j) => (fail = j)));
    const second = render(<BuildingAutoCard />);
    second.unmount();
    fail(new Error("late"));
    await Promise.resolve();
  });
});
