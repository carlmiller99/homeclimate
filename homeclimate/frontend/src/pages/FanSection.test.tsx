import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import FanSection from "./FanSection";
import * as fanApi from "../fanApi";
import * as zonesApi from "../zonesApi";

vi.mock("../fanApi", async (orig) => ({
  ...(await orig<typeof import("../fanApi")>()),
  getFan: vi.fn(),
}));
vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  updateZone: vi.fn(),
}));

const UP: fanApi.FanZone = {
  thermostat_entity_id: "climate.up",
  name: "Upstairs",
  level: "off",
  air_intake: "unsure",
  supported: true,
  running: false,
  note: "",
  minutes_last_hour: 0,
};
const fan = (...zones: fanApi.FanZone[]): fanApi.Fan => ({ zones });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fanApi.getFan).mockResolvedValue(fan(UP));
  vi.mocked(zonesApi.updateZone).mockResolvedValue({} as zonesApi.ZoneProfile);
});
afterEach(() => vi.useRealTimers());

describe("Smart Control → Fan", () => {
  it("shows each zone's level and changes it", async () => {
    render(<FanSection />);
    expect(screen.getByText("Loading the zones…")).toBeInTheDocument();
    const select = await screen.findByLabelText("Fan for Upstairs");
    expect(select).toHaveValue("off");
    expect(screen.getByText("Off. The fan is left to the thermostat.")).toBeInTheDocument();
    expect(screen.queryByText(/of the last 60 minutes/)).toBeNull();
    vi.mocked(fanApi.getFan).mockResolvedValue(
      fan({
        ...UP,
        level: "on",
        note: "Running: Loft is 2.0° past its target",
        minutes_last_hour: 7,
      })
    );
    fireEvent.change(select, { target: { value: "on" } });
    await waitFor(() =>
      expect(zonesApi.updateZone).toHaveBeenCalledWith("climate.up", { fan_level: "on" })
    );
    await waitFor(() => expect(select).toHaveValue("on"));
    expect(screen.getByText("Running: Loft is 2.0° past its target.")).toBeInTheDocument();
    expect(screen.getByText("Ran 7 of the last 60 minutes.")).toBeInTheDocument();
    expect(screen.getByText(/hands it back to the thermostat afterwards/)).toBeInTheDocument();
  });

  it("says when a thermostat's fan cannot be switched", async () => {
    vi.mocked(fanApi.getFan).mockResolvedValue(fan({ ...UP, supported: false }));
    render(<FanSection />);
    expect(
      await screen.findByText(/does not offer an on and auto fan setting/)
    ).toBeInTheDocument();
  });

  it("reports a refused change and keeps what is stored", async () => {
    render(<FanSection />);
    const select = await screen.findByLabelText("Fan for Upstairs");
    vi.mocked(zonesApi.updateZone).mockRejectedValueOnce(new Error("Zone not found"));
    fireEvent.change(select, { target: { value: "on" } });
    expect(await screen.findByText("Zone not found")).toBeInTheDocument();
    expect(select).toHaveValue("off");
    vi.mocked(zonesApi.updateZone).mockRejectedValueOnce("x");
    fireEvent.change(select, { target: { value: "on" } });
    expect(await screen.findByText("Could not save")).toBeInTheDocument();
  });

  it("says what to do with no zones, and when it cannot load", async () => {
    vi.mocked(fanApi.getFan).mockResolvedValueOnce(fan());
    const { unmount } = render(<FanSection />);
    expect(await screen.findByText(/Add a zone with rooms in My Home/)).toBeInTheDocument();
    unmount();
    vi.mocked(fanApi.getFan).mockRejectedValue(new Error("down"));
    render(<FanSection />);
    expect(await screen.findByText("Could not load the zones.")).toBeInTheDocument();
  });

  it("refreshes, keeps what is shown when a refresh fails, and stops when it has gone", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<FanSection />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByLabelText("Fan for Upstairs")).toHaveValue("off");
    vi.mocked(fanApi.getFan).mockRejectedValueOnce(new Error("blip"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByLabelText("Fan for Upstairs")).toBeInTheDocument();
    expect(screen.queryByText("Could not load the zones.")).toBeNull();
    vi.mocked(fanApi.getFan).mockResolvedValue(fan({ ...UP, level: "watch" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByLabelText("Fan for Upstairs")).toHaveValue("watch");
    // A response that lands after it has gone, or over a save, is dropped.
    let finish: (f: fanApi.Fan) => void = () => {};
    vi.mocked(fanApi.getFan).mockReturnValueOnce(new Promise((r) => (finish = r)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    unmount();
    finish(fan(UP));
    const calls = vi.mocked(fanApi.getFan).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fanApi.getFan).toHaveBeenCalledTimes(calls);
  });

  it("does not let a refresh land over a change being saved", async () => {
    vi.useFakeTimers();
    render(<FanSection />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    let done: (z: zonesApi.ZoneProfile) => void = () => {};
    vi.mocked(zonesApi.updateZone).mockReturnValueOnce(new Promise((r) => (done = r)));
    fireEvent.change(screen.getByLabelText("Fan for Upstairs"), { target: { value: "on" } });
    vi.mocked(fanApi.getFan).mockResolvedValueOnce(fan({ ...UP, level: "watch" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByLabelText("Fan for Upstairs")).toHaveValue("off");
    vi.mocked(fanApi.getFan).mockResolvedValue(fan({ ...UP, level: "on" }));
    await act(async () => {
      done({} as zonesApi.ZoneProfile);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByLabelText("Fan for Upstairs")).toHaveValue("on");
  });
});
