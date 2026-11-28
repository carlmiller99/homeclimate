import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import BuildingAutoCard from "./BuildingAutoCard";
import * as bm from "../buildingModeApi";
import * as zb from "../zoneBalanceApi";
import { buildUnitContext, UnitContext } from "../contexts";

vi.mock("../buildingModeApi", async (orig) => ({
  ...(await orig<typeof import("../buildingModeApi")>()),
  getBuildingModes: vi.fn(),
  setBuildingMode: vi.fn(),
}));
vi.mock("../zoneBalanceApi", async (orig) => ({
  ...(await orig<typeof import("../zoneBalanceApi")>()),
  getZoneBalance: vi.fn(),
  setZoneBalance: vi.fn(),
}));

const zone = (id: string, name: string, over: Partial<bm.ZoneModeState> = {}) => ({
  thermostat_entity_id: id,
  name,
  mode: "follow" as const,
  effective_mode: "auto" as const,
  side: null,
  note: "",
  next_switch_at: null,
  waiting: null,
  held_for: null,
  in_use: false,
  ...over,
});

const MAIN: bm.BuildingMode = {
  building_id: "b1",
  name: "Main House",
  mode: "auto",
  opposite_allowed: true,
  switching: "often",
  switch_threshold: 3,
  zones: [
    zone("climate.north", "North Wing", { side: "heating" }),
    zone("climate.south", "South Wing", { note: "Wants cooling; 3 hours until it may switch" }),
  ],
};

const balanceZone = (id: string, name: string, temp: number | null): zb.BalanceZone => ({
  thermostat_entity_id: id,
  name,
  temp,
  occupied: true,
  target: null,
  toward: null,
  obeyed: true,
  answering: false,
});

const BAL: zb.BalanceBuilding = {
  building_id: "b1",
  name: "Main House",
  level: "on",
  zone_gap: 4,
  direction: "heating",
  spread: 2,
  zones: [
    balanceZone("climate.north", "North Wing", 70),
    balanceZone("climate.south", "South Wing", 72),
  ],
};
const balance = (b: zb.BalanceBuilding[] = [BAL]) => ({ buildings: b, min_gap: 1, max_gap: 10 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.mocked(bm.getBuildingModes).mockResolvedValue([MAIN]);
  vi.mocked(bm.setBuildingMode).mockImplementation(async (_id, patch) => [{ ...MAIN, ...patch }]);
  vi.mocked(zb.getZoneBalance).mockResolvedValue(balance());
  vi.mocked(zb.setZoneBalance).mockImplementation(async (_id, patch) =>
    balance([{ ...BAL, ...patch }])
  );
});

describe("Smart Control → Auto Mode", () => {
  const pick = (group: string, name: string) =>
    within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

  it("lets a building's zones run opposite each other, or not", async () => {
    render(<BuildingAutoCard />);
    expect(screen.getByText("Loading the buildings…")).toBeInTheDocument();
    const group = "Zones in Main House may run opposite each other";
    await screen.findByRole("radiogroup", { name: group });
    expect(pick(group, "Yes")).toBeChecked();
    expect(
      screen.getByText(/^When No, one zone may heat while another coasts/)
    ).toBeInTheDocument();
    fireEvent.click(pick(group, "Yes"));
    expect(bm.setBuildingMode).not.toHaveBeenCalled();
    fireEvent.click(pick(group, "No"));
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { opposite_allowed: false })
    );
    await waitFor(() => expect(pick(group, "No")).toBeChecked());
    fireEvent.click(pick(group, "Yes"));
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenLastCalledWith("b1", { opposite_allowed: true })
    );
  });

  it("chooses how often zones may switch, with the real choices", async () => {
    render(<BuildingAutoCard />);
    const group = await screen.findByRole("radiogroup", {
      name: "How often zones in Main House may switch",
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
    fireEvent.click(within(group).getByRole("radio", { name: "Once a Day" }));
    await waitFor(() =>
      expect(bm.setBuildingMode).toHaveBeenCalledWith("b1", { switching: "daily" })
    );
    expect(await screen.findByText(/^Once in any 24 hours/)).toBeInTheDocument();
  });

  it("keeps zones within a gap, and shows how far apart they are now", async () => {
    render(<BuildingAutoCard />);
    const gap = await screen.findByLabelText("Gap limit for Main House");
    expect(gap).toHaveValue("4");
    const on = screen.getByRole("switch", { name: "Keep zones in Main House within the gap" });
    expect(on).toBeChecked();
    expect(screen.getByText("Right Now")).toBeInTheDocument();
    expect(screen.getByText("Gap 2.0°F of 4.0°F allowed")).toBeInTheDocument();
    // Why a zone has not switched yet is said beside the gap.
    expect(
      screen.getByText(/South Wing wants cooling; 3 hours until it may switch\.$/)
    ).toBeInTheDocument();
    fireEvent.change(gap, { target: { value: "6" } });
    await waitFor(() => expect(zb.setZoneBalance).toHaveBeenCalledWith("b1", { zone_gap: 6 }));
    await waitFor(() => expect(on).toBeEnabled());
    fireEvent.click(on);
    await waitFor(() => expect(zb.setZoneBalance).toHaveBeenLastCalledWith("b1", { level: "off" }));
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Keep zones in Main House within the gap" })
      ).not.toBeChecked()
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Keep zones in Main House within the gap" })
    );
    await waitFor(() => expect(zb.setZoneBalance).toHaveBeenLastCalledWith("b1", { level: "on" }));
  });

  it("offers a stored gap that is not one of the choices, and waits for two readings", async () => {
    vi.mocked(zb.getZoneBalance).mockResolvedValue(
      balance([
        {
          ...BAL,
          zone_gap: 7,
          spread: null,
          direction: null,
          zones: [
            { ...BAL.zones[0], target: 72 },
            { ...BAL.zones[1], temp: null },
          ],
        },
      ])
    );
    render(<BuildingAutoCard />);
    const gap = await screen.findByLabelText("Gap limit for Main House");
    expect(gap).toHaveValue("7");
    expect(
      within(gap)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toContain("7");
    expect(screen.getByText("Waiting for two readings")).toBeInTheDocument();
    expect(screen.getByText("No reading")).toBeInTheDocument();
  });

  it("leaves out what one zone has no use for", async () => {
    vi.mocked(bm.getBuildingModes).mockResolvedValue([{ ...MAIN, zones: [MAIN.zones[0]] }]);
    render(<BuildingAutoCard />);
    await screen.findByRole("radiogroup", { name: "How often zones in Main House may switch" });
    expect(screen.queryByRole("radiogroup", { name: /run opposite/ })).toBeNull();
    expect(screen.queryByLabelText("Gap limit for Main House")).toBeNull();
  });

  it("does not show the gap when it cannot be read, and keeps it over a failed refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(zb.getZoneBalance).mockRejectedValueOnce(new Error("down"));
    render(<BuildingAutoCard />);
    await screen.findByRole("radiogroup", { name: "How often zones in Main House may switch" });
    expect(screen.queryByLabelText("Gap limit for Main House")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(await screen.findByLabelText("Gap limit for Main House")).toHaveValue("4");
    vi.mocked(zb.getZoneBalance).mockRejectedValueOnce(new Error("down"));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByLabelText("Gap limit for Main House")).toHaveValue("4");
    vi.useRealTimers();
  });

  it("keeps a refresh from landing over a change being saved", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let finish!: (z: zb.ZoneBalance) => void;
    vi.mocked(zb.setZoneBalance).mockReturnValueOnce(new Promise((r) => (finish = r)));
    render(<BuildingAutoCard />);
    fireEvent.change(await screen.findByLabelText("Gap limit for Main House"), {
      target: { value: "8" },
    });
    vi.mocked(zb.getZoneBalance).mockResolvedValueOnce(balance([{ ...BAL, zone_gap: 3 }]));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await act(async () => finish(balance([{ ...BAL, zone_gap: 8 }])));
    expect(screen.getByLabelText("Gap limit for Main House")).toHaveValue("8");
    vi.useRealTimers();
  });

  it("shows the gap in Celsius as the house reads it", async () => {
    render(
      <UnitContext.Provider value={buildUnitContext("C")}>
        <BuildingAutoCard />
      </UnitContext.Provider>
    );
    // 4 °F is 2.2 °C: not a choice, so it is added.
    const gap = await screen.findByLabelText("Gap limit for Main House");
    expect(gap).toHaveValue("2.2");
    fireEvent.change(gap, { target: { value: "2.5" } });
    await waitFor(() => expect(zb.setZoneBalance).toHaveBeenCalledWith("b1", { zone_gap: 2.5 }));
  });

  it("saves the switching threshold as typed, inside its limits", async () => {
    render(<BuildingAutoCard />);
    const field = await screen.findByLabelText("Switching threshold for Main House (°F)");
    expect(field).toHaveValue(3);
    expect(field).toHaveAttribute("title", "Between 0 and 10°F.");
    // Leaving it as it was, or with something it cannot be, saves nothing.
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: "11" } });
    expect(screen.getByText("Between 0 and 10°F.")).toBeInTheDocument();
    fireEvent.blur(field);
    expect(screen.queryByText("Between 0 and 10°F.")).toBeNull();
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
    vi.mocked(bm.setBuildingMode).mockResolvedValue([{ ...MAIN, switch_threshold: 3.6 }]);
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
    const group = "Zones in Main House may run opposite each other";
    await screen.findByRole("radiogroup", { name: group });
    vi.mocked(bm.setBuildingMode).mockRejectedValueOnce(new Error("Building not found"));
    fireEvent.click(pick(group, "No"));
    expect(await screen.findByText("Building not found")).toBeInTheDocument();
    expect(pick(group, "Yes")).toBeChecked();
    vi.mocked(bm.setBuildingMode).mockRejectedValueOnce("x");
    fireEvent.click(pick(group, "No"));
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
