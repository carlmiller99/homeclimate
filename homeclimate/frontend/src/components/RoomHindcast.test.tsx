import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RoomHindcast from "./RoomHindcast";
import * as la from "../learningApi";
import { buildTimeZoneContext, buildUnitContext, TimeZoneContext, UnitContext } from "../contexts";

vi.mock("../learningApi", async (orig) => ({
  ...(await orig<typeof import("../learningApi")>()),
  getHindcast: vi.fn(),
}));

const at = (h: number, m = 0) =>
  `2026-02-02T${String(h + 5).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+00:00`;

const day = (over: Partial<la.Hindcast> = {}): la.Hindcast => ({
  room_id: "den",
  name: "Den",
  day: "2026-02-02",
  // Midnight to midnight in New York.
  start: "2026-02-02T05:00:00+00:00",
  end: "2026-02-03T05:00:00+00:00",
  points: [
    { at: at(0), measured: 66, predicted: null },
    { at: at(6), measured: 68, predicted: 68.5 },
    { at: at(12), measured: 70, predicted: 69 },
    { at: at(15), measured: 71, predicted: null },
    { at: at(18), measured: 70, predicted: 70.2 },
  ],
  typical_miss: 0.6,
  predicted_points: 3,
  ...over,
});

const show = (unit: "F" | "C" = "F") =>
  render(
    <TimeZoneContext.Provider value={buildTimeZoneContext("America/New_York")}>
      <UnitContext.Provider value={buildUnitContext(unit)}>
        <RoomHindcast roomId="den" name="Den" />
      </UnitContext.Provider>
    </TimeZoneContext.Provider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(la.getHindcast).mockResolvedValue(day());
});

describe("A room's predicted-against-measured chart", () => {
  it("draws the measured day, and the prediction wherever the model could say", async () => {
    const { container } = show();
    expect(screen.getByText("Loading the chart…")).toBeInTheDocument();
    const chart = await screen.findByRole("img");
    expect(la.getHindcast).toHaveBeenCalledWith("den");
    expect(chart).toHaveAccessibleName(
      "Den ranged from 66°F to 71°F. Typically 0.6°F off, one hour ahead."
    );
    expect(screen.getByText(/^Den: predicted against measured, .*2\/2\/2026/)).toBeInTheDocument();
    const measured = container.querySelector(".hindcast-measured")!;
    // Five points, the first at the left edge and the lowest reading at the bottom.
    const pts = measured.getAttribute("points")!.split(" ");
    expect(pts).toHaveLength(5);
    expect(pts[0]).toBe("0.0,152.0");
    expect(pts[1].startsWith("180.0,")).toBe(true);
    // The prediction is broken where it could not say: two runs, not one line.
    const runs = container.querySelectorAll(".hindcast-predicted");
    expect(runs).toHaveLength(2);
    expect(runs[0].getAttribute("points")!.split(" ")).toHaveLength(2);
    expect(runs[1].getAttribute("points")!.split(" ")).toHaveLength(1);
    expect(screen.getByText("71.0°F")).toBeInTheDocument();
    expect(screen.getByText("66.0°F")).toBeInTheDocument();
  });

  it("shows the miss as a difference in Celsius", async () => {
    show("C");
    expect(await screen.findByText("Typically 0.33°C off, one hour ahead.")).toBeInTheDocument();
  });

  it("draws a flat day, and says when the model could not speak", async () => {
    vi.mocked(la.getHindcast).mockResolvedValue(
      day({
        points: [
          { at: at(0), measured: 68, predicted: null },
          { at: at(12), measured: 68, predicted: null },
        ],
        typical_miss: null,
        predicted_points: 0,
      })
    );
    const { container } = show();
    expect(
      await screen.findByText("The model could not speak for this day yet.")
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".hindcast-predicted")).toHaveLength(0);
    expect(container.querySelector(".hindcast-measured")!.getAttribute("points")).toBe(
      "0.0,152.0 360.0,152.0"
    );
  });

  it("says so with no readings, and when it cannot load", async () => {
    vi.mocked(la.getHindcast).mockResolvedValue(day({ points: [] }));
    const first = show();
    expect(await screen.findByText("No readings for Den yesterday.")).toBeInTheDocument();
    first.unmount();
    vi.mocked(la.getHindcast).mockRejectedValue(new Error("down"));
    show();
    expect(await screen.findByText("Could not load Den's chart.")).toBeInTheDocument();
  });

  it("ignores a response that arrives after it is gone", async () => {
    let finish: (d: la.Hindcast) => void = () => {};
    let fail: (e: Error) => void = () => {};
    vi.mocked(la.getHindcast).mockReturnValueOnce(new Promise((r) => (finish = r)));
    show().unmount();
    finish(day());
    vi.mocked(la.getHindcast).mockReturnValueOnce(new Promise((_r, j) => (fail = j)));
    show().unmount();
    fail(new Error("late"));
    await Promise.resolve();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
