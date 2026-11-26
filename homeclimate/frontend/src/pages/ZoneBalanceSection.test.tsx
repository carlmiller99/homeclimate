import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ZoneBalanceSection from "./ZoneBalanceSection";
import * as zb from "../zoneBalanceApi";
import { buildUnitContext, UnitContext } from "../contexts";

vi.mock("../zoneBalanceApi", async (orig) => ({
  ...(await orig<typeof import("../zoneBalanceApi")>()),
  getZoneBalance: vi.fn(),
  setZoneBalance: vi.fn(),
}));

const zone = (name: string, temp: number | null, over: Partial<zb.BalanceZone> = {}) => ({
  thermostat_entity_id: `climate.${name.toLowerCase()}`,
  name,
  temp,
  occupied: false,
  target: null,
  toward: null,
  obeyed: false,
  answering: false,
  ...over,
});

const MAIN: zb.BalanceBuilding = {
  building_id: "b1",
  name: "Main House",
  level: "off",
  zone_gap: 3,
  direction: null,
  spread: 6,
  zones: [zone("North", 70), zone("South", 64)],
};

const wrap = (buildings: zb.BalanceBuilding[]): zb.ZoneBalance => ({
  buildings,
  min_gap: 2,
  max_gap: 10,
});

const f = buildUnitContext("F");
const text = (b: Partial<zb.BalanceBuilding>) =>
  zb.describeBalance({ ...MAIN, ...b }, f.fmtTemp, (d) => `${d.toFixed(1)}°F`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(zb.getZoneBalance).mockResolvedValue(wrap([MAIN]));
  vi.mocked(zb.setZoneBalance).mockImplementation(async (_id, patch) =>
    wrap([{ ...MAIN, ...patch }])
  );
});

describe("Zone Balance", () => {
  it("shows each building's zones and changes its level and gap limit", async () => {
    render(<ZoneBalanceSection />);
    expect(screen.getByText("Loading the buildings…")).toBeInTheDocument();
    const level = await screen.findByLabelText("Balance for Main House");
    expect(level).toHaveValue("off");
    expect(screen.getByText("Zones are 6.0°F apart.")).toBeInTheDocument();
    // Each zone on a line from the coolest reading to the warmest.
    expect(screen.getByText("Main House right now")).toBeInTheDocument();
    expect(screen.getByText("Gap 6.0°F of 3.0°F allowed")).toBeInTheDocument();
    const dots = [...document.querySelectorAll<HTMLElement>(".balance-dot")];
    expect(dots.map((d) => d.style.left)).toEqual(["90%", "10%"]);
    expect(screen.getByText("70.0°F")).toBeInTheDocument();
    expect(screen.getByText("64.0°F")).toBeInTheDocument();
    fireEvent.change(level, { target: { value: "on" } });
    await waitFor(() => expect(zb.setZoneBalance).toHaveBeenCalledWith("b1", { level: "on" }));
    await waitFor(() => expect(screen.getByLabelText("Balance for Main House")).toHaveValue("on"));
    expect(screen.getByText(/^On: a zone that falls further behind/)).toBeInTheDocument();
    const gap = screen.getByLabelText("Gap limit for Main House");
    expect(gap).toHaveValue("3");
    fireEvent.change(gap, { target: { value: "5" } });
    await waitFor(() => expect(zb.setZoneBalance).toHaveBeenLastCalledWith("b1", { zone_gap: 5 }));
  });

  it("sends the gap as typed in Celsius, and offers a stored value that is not on the list", async () => {
    // 3.6 °F is 2.0 °C, a listed choice; 4 °F is 2.2 °C, which is not.
    vi.mocked(zb.getZoneBalance).mockResolvedValue(wrap([{ ...MAIN, zone_gap: 4 }]));
    render(
      <UnitContext.Provider value={buildUnitContext("C")}>
        <ZoneBalanceSection />
      </UnitContext.Provider>
    );
    const gap = await screen.findByLabelText("Gap limit for Main House");
    expect(gap).toHaveValue("2.2");
    expect(screen.getByText("Limit the Gap Between Zones in Main House To")).toBeInTheDocument();
    expect(screen.getByText("°C")).toBeInTheDocument();
    fireEvent.change(gap, { target: { value: "2.5" } });
    await waitFor(() => expect(zb.setZoneBalance).toHaveBeenCalledWith("b1", { zone_gap: 2.5 }));
  });

  it("says what a building is doing about its zones", () => {
    expect(text({ zones: [zone("North", 70)] })).toBe("Needs two zones in the building.");
    expect(text({ spread: null })).toBe("Waiting for a temperature from two zones.");
    expect(text({ level: "on" })).toBe(
      "Zones are 6.0°F apart. Nothing is heating or cooling here, so nothing is balanced."
    );
    expect(text({ level: "on", direction: "heating" })).toBe(
      "Zones are 6.0°F apart. No zone is in use, so nothing is balanced."
    );
    const used = zone("North", 70, { occupied: true });
    expect(text({ level: "on", direction: "heating", zones: [used, zone("South", 68)] })).toBe(
      "Zones are 6.0°F apart. Inside the limit."
    );
    const asked = zone("South", 64, { target: 67, toward: "climate.north", obeyed: true });
    expect(text({ level: "on", direction: "heating", zones: [used, asked] })).toBe(
      "Zones are 6.0°F apart. Asking for South to 67.0°F, but no room there can answer: each has its own target, is paused, or is close enough already."
    );
    const called = { ...asked, answering: true };
    expect(text({ level: "on", direction: "heating", zones: [used, called] })).toBe(
      "Zones are 6.0°F apart. Now heating South to 67.0°F."
    );
    expect(
      text({ level: "watch", direction: "cooling", zones: [used, { ...called, obeyed: false }] })
    ).toBe("Zones are 6.0°F apart. Would be cooling South to 67.0°F (watching only).");
    expect(text({ level: "watch", direction: null, zones: [used, called] })).toMatch(/Now heating/);
  });

  it("shows a zone with no reading, an empty house, and errors", async () => {
    vi.mocked(zb.getZoneBalance).mockResolvedValue(
      wrap([{ ...MAIN, spread: null, zones: [zone("North", 70), zone("South", null)] }])
    );
    const first = render(<ZoneBalanceSection />);
    expect(await screen.findByText("No reading")).toBeInTheDocument();
    expect(screen.getByText("Waiting for two readings")).toBeInTheDocument();
    expect(document.querySelectorAll(".balance-dot")).toHaveLength(1);
    vi.mocked(zb.setZoneBalance).mockRejectedValueOnce(new Error("Nope"));
    fireEvent.change(screen.getByLabelText("Balance for Main House"), { target: { value: "on" } });
    expect(await screen.findByText("Nope")).toBeInTheDocument();
    vi.mocked(zb.setZoneBalance).mockRejectedValueOnce("x");
    fireEvent.change(screen.getByLabelText("Balance for Main House"), { target: { value: "on" } });
    expect(await screen.findByText("Could not save")).toBeInTheDocument();
    first.unmount();
    vi.mocked(zb.getZoneBalance).mockResolvedValue(wrap([]));
    const second = render(<ZoneBalanceSection />);
    expect(await screen.findByText(/Add a building in My Home/)).toBeInTheDocument();
    second.unmount();
    vi.mocked(zb.getZoneBalance).mockRejectedValue(new Error("down"));
    render(<ZoneBalanceSection />);
    expect(await screen.findByText("Could not load the buildings.")).toBeInTheDocument();
  });

  it("looks again every half minute, and keeps what it shows if a refresh fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<ZoneBalanceSection />);
      expect(await screen.findByText("Zones are 6.0°F apart.")).toBeInTheDocument();
      vi.mocked(zb.getZoneBalance).mockResolvedValueOnce(wrap([{ ...MAIN, spread: 4 }]));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await screen.findByText("Zones are 4.0°F apart.")).toBeInTheDocument();
      vi.mocked(zb.getZoneBalance).mockRejectedValueOnce(new Error("blip"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(screen.getByText("Zones are 4.0°F apart.")).toBeInTheDocument();
      expect(screen.queryByText("Could not load the buildings.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a load that finishes after it has gone", async () => {
    let finish: (d: zb.ZoneBalance) => void = () => {};
    let fail: (e: Error) => void = () => {};
    vi.mocked(zb.getZoneBalance)
      .mockReturnValueOnce(new Promise((r) => (finish = r)))
      .mockReturnValueOnce(new Promise((_r, j) => (fail = j)));
    const a = render(<ZoneBalanceSection />);
    a.unmount();
    finish(wrap([MAIN]));
    const b = render(<ZoneBalanceSection />);
    b.unmount();
    fail(new Error("late"));
    await Promise.resolve();
    render(
      <StrictMode>
        <ZoneBalanceSection />
      </StrictMode>
    );
    expect(await screen.findByLabelText("Balance for Main House")).toBeInTheDocument();
  });
});
