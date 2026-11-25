import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PeakSection from "./PeakSection";
import * as pa from "../peakApi";
import { buildUnitContext, UnitContext } from "../contexts";

vi.mock("../peakApi", async (orig) => ({
  ...(await orig<typeof import("../peakApi")>()),
  getPeakHours: vi.fn(),
  updatePeakHours: vi.fn(),
}));

const WINDOW: pa.PeakWindow = {
  bank_from: "2026-07-06T17:30:00+00:00",
  start: "2026-07-06T19:00:00+00:00",
  end: "2026-07-07T00:00:00+00:00",
  banking: false,
  under_way: false,
};

const data = (over: Partial<pa.PeakHours> = {}): pa.PeakHours => ({
  enabled: true,
  start: "14:00",
  end: "19:00",
  days: [0, 1, 2, 3, 4],
  lead_min: 90,
  peak_depth: 2,
  window: WINDOW,
  min_depth: 1,
  max_depth: 5,
  min_lead_min: 30,
  max_lead_min: 180,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pa.getPeakHours).mockResolvedValue(data());
  vi.mocked(pa.updatePeakHours).mockImplementation(async (patch) => data(patch));
});

describe("Peak Hours", () => {
  it("shows the settings and saves each change", async () => {
    render(
      <StrictMode>
        <PeakSection />
      </StrictMode>
    );
    expect(screen.getByText("Loading Peak Hours…")).toBeInTheDocument();
    const start = await screen.findByLabelText("Peak starts");
    expect(start).toHaveValue("14:00");
    expect(screen.getByRole("status")).toHaveTextContent(/^Next peak .*; banking starts /);
    fireEvent.change(start, { target: { value: "15:00" } });
    await waitFor(() => expect(pa.updatePeakHours).toHaveBeenLastCalledWith({ start: "15:00" }));
    await waitFor(() => expect(screen.getByLabelText("Peak ends")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Peak ends"), { target: { value: "20:00" } });
    await waitFor(() => expect(pa.updatePeakHours).toHaveBeenLastCalledWith({ end: "20:00" }));
    // A cleared time is not sent.
    await waitFor(() => expect(screen.getByLabelText("Peak ends")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Peak ends"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Peak starts"), { target: { value: "" } });
    expect(pa.updatePeakHours).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "Sat" }));
    await waitFor(() =>
      expect(pa.updatePeakHours).toHaveBeenLastCalledWith({ days: [0, 1, 2, 3, 4, 5] })
    );
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Mon" })).toBeEnabled());
    fireEvent.click(screen.getByRole("checkbox", { name: "Mon" }));
    await waitFor(() =>
      expect(pa.updatePeakHours).toHaveBeenLastCalledWith({ days: [1, 2, 3, 4, 5] })
    );
    await waitFor(() => expect(screen.getByLabelText("Start banking")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Start banking"), { target: { value: "60" } });
    await waitFor(() => expect(pa.updatePeakHours).toHaveBeenLastCalledWith({ lead_min: 60 }));
    await waitFor(() => expect(screen.getByLabelText("How far to bank")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("How far to bank"), { target: { value: "3" } });
    await waitFor(() => expect(pa.updatePeakHours).toHaveBeenLastCalledWith({ peak_depth: 3 }));
    await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
    fireEvent.click(screen.getByRole("switch", { name: /Bank Ahead of Peak Hours/ }));
    await waitFor(() => expect(pa.updatePeakHours).toHaveBeenLastCalledWith({ enabled: false }));
  });

  it("sends the depth as chosen in Celsius, and offers stored values that are not on the lists", async () => {
    // 2 °F is 1.1 °C, which is not a listed choice; nor is 75 minutes.
    vi.mocked(pa.getPeakHours).mockResolvedValue(data({ lead_min: 75 }));
    render(
      <UnitContext.Provider value={buildUnitContext("C")}>
        <PeakSection />
      </UnitContext.Provider>
    );
    const depth = await screen.findByLabelText("How far to bank");
    expect(depth).toHaveValue("1.1");
    expect(screen.getByLabelText("Start banking")).toHaveValue("75");
    expect(screen.getByText("How Far to Bank (°C)")).toBeInTheDocument();
    fireEvent.change(depth, { target: { value: "1.5" } });
    await waitFor(() => expect(pa.updatePeakHours).toHaveBeenCalledWith({ peak_depth: 1.5 }));
  });

  it("says what is happening with the peak", () => {
    const fmt = (iso: string) => iso.slice(11, 16);
    expect(pa.describePeak(data({ enabled: false }), fmt)).toBe("Off: nothing is banked.");
    expect(pa.describePeak(data({ window: null }), fmt)).toBe("No peak hours are set for any day.");
    expect(pa.describePeak(data(), fmt)).toBe("Next peak 19:00; banking starts 17:30.");
    expect(pa.describePeak(data({ window: { ...WINDOW, banking: true } }), fmt)).toBe(
      "Banking now for the peak at 19:00."
    );
    expect(pa.describePeak(data({ window: { ...WINDOW, under_way: true } }), fmt)).toBe(
      "Peak hours now, until 00:00."
    );
  });

  it("shows a refused change, and a failed load", async () => {
    const first = render(<PeakSection />);
    await screen.findByLabelText("Peak starts");
    vi.mocked(pa.updatePeakHours).mockRejectedValueOnce(new Error("Times must differ"));
    fireEvent.change(screen.getByLabelText("Peak starts"), { target: { value: "19:00" } });
    expect(await screen.findByText("Times must differ")).toBeInTheDocument();
    vi.mocked(pa.updatePeakHours).mockRejectedValueOnce("x");
    fireEvent.change(screen.getByLabelText("Peak starts"), { target: { value: "18:00" } });
    expect(await screen.findByText("Could not save")).toBeInTheDocument();
    first.unmount();
    vi.mocked(pa.getPeakHours).mockRejectedValue(new Error("down"));
    render(<PeakSection />);
    expect(await screen.findByText("Could not load Peak Hours.")).toBeInTheDocument();
  });

  it("ignores a load that finishes after it has gone", async () => {
    let finish: (d: pa.PeakHours) => void = () => {};
    let fail: (e: Error) => void = () => {};
    vi.mocked(pa.getPeakHours)
      .mockReturnValueOnce(new Promise((r) => (finish = r)))
      .mockReturnValueOnce(new Promise((_r, j) => (fail = j)));
    render(<PeakSection />).unmount();
    finish(data());
    render(<PeakSection />).unmount();
    fail(new Error("late"));
    await Promise.resolve();
    expect(screen.queryByText("Could not load Peak Hours.")).toBeNull();
  });
});
