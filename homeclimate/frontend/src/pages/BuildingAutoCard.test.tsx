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
    expect(screen.getByText(/as it always has/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "watch" } });
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { auto_level: "watch" })
    );
    await waitFor(() => expect(screen.getByLabelText("Auto for Main House")).toHaveValue("watch"));
    expect(screen.getByText(/but holds nothing/)).toBeInTheDocument();
    expect(screen.queryByText(/fixed mode/)).not.toBeInTheDocument();
  });

  it("gives the urgent threshold in the house's unit", async () => {
    const { unmount } = render(<BuildingAutoCard />);
    await screen.findByLabelText("Auto for Main House");
    expect(screen.getByText(/2° past where it would/)).toBeInTheDocument();
    unmount();
    render(
      <UnitContext.Provider value={buildUnitContext("C")}>
        <BuildingAutoCard />
      </UnitContext.Provider>
    );
    await screen.findByLabelText("Auto for Main House");
    expect(screen.getByText(/1\.1° past where it would/)).toBeInTheDocument();
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
