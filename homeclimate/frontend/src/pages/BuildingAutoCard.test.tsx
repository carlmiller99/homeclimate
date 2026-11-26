import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("One Side Per Building", () => {
  it("shows each building's level and changes it", async () => {
    render(<BuildingAutoCard />);
    expect(screen.getByText("Loading the buildings…")).toBeInTheDocument();
    const select = await screen.findByLabelText("Auto for Main House");
    expect(select).toHaveValue("off");
    expect(screen.getByText(/^Zones run independently/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "watch" } });
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { auto_level: "watch" })
    );
    await waitFor(() => expect(screen.getByLabelText("Auto for Main House")).toHaveValue("watch"));
    expect(screen.getByText(/but holds nothing/)).toBeInTheDocument();
    expect(screen.queryByText(/fixed mode/)).not.toBeInTheDocument();
  });

  it("chooses how often Auto may change sides, and explains each choice", async () => {
    render(<BuildingAutoCard />);
    const select = await screen.findByLabelText("Auto may change sides for Main House");
    expect(select).toHaveValue("often");
    // The chosen one is explained under the list, and all four further down.
    expect(screen.getAllByText(/no more than twice a day/)).toHaveLength(2);
    expect(screen.getByText("What each choice means")).toBeInTheDocument();
    expect(screen.getAllByText(/One change in any 30 days/)).toHaveLength(1);
    fireEvent.change(select, { target: { value: "monthly" } });
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { switching: "monthly" })
    );
    await waitFor(() => expect(select).toHaveValue("monthly"));
    expect(screen.getAllByText(/One change in any 30 days/)).toHaveLength(2);
    expect(select.querySelector("option[value=weekly]")).toHaveAttribute(
      "title",
      expect.stringContaining("7 days")
    );
  });

  it("saves the switching threshold as typed, inside its limits", async () => {
    render(<BuildingAutoCard />);
    const field = await screen.findByLabelText("Switching threshold for Main House (°F)");
    const save = screen.getByRole("button", { name: "Save switching threshold for Main House" });
    expect(field).toHaveValue(3);
    expect(save).toBeDisabled();
    fireEvent.change(field, { target: { value: "11" } });
    expect(save).toBeDisabled();
    expect(screen.getByText("Between 0 and 10°F.")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "" } });
    expect(save).toBeDisabled();
    fireEvent.change(field, { target: { value: "4.5" } });
    expect(screen.getByText(/before Auto considers changing sides/)).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { switch_threshold: 4.5 })
    );
    await waitFor(() => expect(save).toBeDisabled());
    expect(field).toHaveValue(4.5);
  });

  it("shows and sends the threshold in Celsius without converting it", async () => {
    // The backend converts: 2 °C typed is stored as 3.6 °F and comes back as that.
    vi.mocked(bm.setBuildingMode).mockResolvedValue([{ ...MAIN, switch_threshold: 3.6 }]);
    render(
      <UnitContext.Provider value={buildUnitContext("C")}>
        <BuildingAutoCard />
      </UnitContext.Provider>
    );
    const field = await screen.findByLabelText("Switching threshold for Main House (°C)");
    expect(field).toHaveValue(1.67);
    fireEvent.change(field, { target: { value: "9" } });
    expect(screen.getByText("Between 0 and 5.56°C.")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save switching threshold for Main House" })
    );
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { switch_threshold: 2 })
    );
    await waitFor(() => expect(field).toHaveValue(2));
  });

  it("says when a fixed mode means Auto is not in use", async () => {
    vi.mocked(bm.getBuildingModes).mockResolvedValue([{ ...MAIN, mode: "heat_only" }]);
    render(<BuildingAutoCard />);
    expect(await screen.findByText(/fixed mode on the Dashboard/)).toBeInTheDocument();
  });

  it("reports a refused change and keeps what is stored", async () => {
    render(<BuildingAutoCard />);
    const select = await screen.findByLabelText("Auto for Main House");
    vi.mocked(bm.setBuildingMode).mockRejectedValueOnce(new Error("Building not found"));
    fireEvent.change(select, { target: { value: "on" } });
    expect(await screen.findByText("Building not found")).toBeInTheDocument();
    expect(select).toHaveValue("off");
    vi.mocked(bm.setBuildingMode).mockRejectedValueOnce("x");
    fireEvent.change(select, { target: { value: "on" } });
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
