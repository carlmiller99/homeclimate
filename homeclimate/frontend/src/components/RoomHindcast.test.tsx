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
  ticks: [at(0), at(6), at(12), at(18), "2026-02-03T05:00:00+00:00"],
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
    // Readings hours apart are not joined: each stands alone as a dot, the
    // first at the left edge and the lowest reading at the bottom.
    expect(container.querySelectorAll(".hindcast-measured")).toHaveLength(0);
    const dots = container.querySelectorAll(".hindcast-dot-measured");
    expect(dots).toHaveLength(5);
    expect(dots[0].getAttribute("cx")).toBe("0");
    expect(dots[0].getAttribute("cy")).toBe("152");
    expect(dots[1].getAttribute("cx")).toBe("180");
    expect(container.querySelectorAll(".hindcast-dot-predicted")).toHaveLength(3);
    // The clock marks sit where the house's clock reads them.
    const marks = [...container.querySelectorAll<HTMLElement>(".hindcast-axis span")];
    expect(marks.map((m) => m.textContent)).toEqual([
      "Midnight",
      "6 AM",
      "Noon",
      "6 PM",
      "Midnight",
    ]);
    expect(marks.map((m) => m.style.left)).toEqual(["0%", "25%", "50%", "75%", "100%"]);
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
          { at: at(0, 15), measured: 68, predicted: null },
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
      "0.0,152.0 7.5,152.0"
    );
  });

  it("joins close readings, breaks across a gap, and moves the marks on a short day", async () => {
    const m = (h: number, min: number) => at(h, min);
    vi.mocked(la.getHindcast).mockResolvedValue(
      day({
        // A 23-hour day: 6 AM comes five hours in.
        end: "2026-02-03T04:00:00+00:00",
        ticks: [at(0), at(5), at(11), at(17), "2026-02-03T04:00:00+00:00"],
        points: [
          { at: m(1, 0), measured: 66, predicted: 66 },
          { at: m(1, 15), measured: 66.5, predicted: 66.4 },
          { at: m(1, 30), measured: 67, predicted: null },
          // Nothing recorded for two hours.
          { at: m(3, 30), measured: 68, predicted: 68 },
          { at: m(3, 45), measured: 68.2, predicted: 68.1 },
        ],
      })
    );
    const { container } = show();
    await screen.findByRole("img");
    const measured = container.querySelectorAll(".hindcast-measured");
    expect(measured).toHaveLength(2);
    expect(measured[0].getAttribute("points")!.split(" ")).toHaveLength(3);
    expect(measured[1].getAttribute("points")!.split(" ")).toHaveLength(2);
    expect(container.querySelectorAll(".hindcast-predicted")).toHaveLength(2);
    expect(container.querySelectorAll("circle")).toHaveLength(0);
    const marks = [...container.querySelectorAll<HTMLElement>(".hindcast-axis span")];
    expect(marks[1].style.left).toBe(`${(5 / 23) * 100}%`);
    expect(marks[4].style.left).toBe("100%");
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
