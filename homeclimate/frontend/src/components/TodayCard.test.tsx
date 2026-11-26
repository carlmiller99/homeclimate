import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTimeZoneContext, buildUnitContext, TimeZoneContext, UnitContext } from "../contexts";
import * as ta from "../todayApi";
import { MemoryRouter } from "react-router";
import TodayCard from "./TodayCard";

vi.mock("../todayApi", async (orig) => ({
  ...(await orig<typeof import("../todayApi")>()),
  getToday: vi.fn(),
}));

const HOURS: ta.TodayHour[] = [
  ...Array.from({ length: 6 }, (_, i) => ({
    at: `2026-07-06T${String(8 + i).padStart(2, "0")}:00:00+00:00`,
    temp: 58 + i,
    need: "heat" as const,
  })),
  { at: "2026-07-06T14:00:00+00:00", temp: 68, need: "coast" },
  { at: "2026-07-06T15:00:00+00:00", temp: 86, need: "cool" },
];

const TODAY: ta.Today = {
  now: "2026-07-06T08:20:00+00:00",
  heat_below: 66,
  cool_above: 76,
  forecast_fetched_at: "2026-07-06T08:00:00+00:00",
  hours: HOURS,
  events: [
    { at: "2026-07-06T15:00:00+00:00", kind: "peak_bank" },
    { at: "2026-07-06T16:00:00+00:00", kind: "peak_start" },
    {
      at: "2026-07-06T18:00:00+00:00",
      kind: "schedule",
      room_id: "r1",
      room: "Bunk Room",
      target: 68,
      cool_to: 74,
    },
    { at: "2026-07-06T19:00:00+00:00", kind: "peak_end" },
    {
      at: "2026-07-07T09:00:00+00:00",
      kind: "schedule",
      room_id: "r2",
      room: "Craft Room",
      target: 70,
      cool_to: null,
    },
  ],
  yesterday: "Yesterday heating ran 3 times for 1 h 10 min. No warnings.",
};

function show(unit: "F" | "C" = "F") {
  return render(
    <TimeZoneContext.Provider value={buildTimeZoneContext("America/New_York")}>
      <UnitContext.Provider value={buildUnitContext(unit)}>
        <TodayCard />
      </UnitContext.Provider>
    </TimeZoneContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(ta.getToday).mockResolvedValue(TODAY);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("describing the plan", () => {
  it("counts the hours of each kind and leaves out what there is none of", () => {
    expect(ta.describeNeeds(HOURS)).toBe("6 hours heating, 1 hour coasting, 1 hour cooling");
    expect(ta.describeNeeds(HOURS.slice(0, 6))).toBe("6 hours heating");
    expect(ta.describeNeeds([])).toBe("");
  });

  it("puts the strip in words", () => {
    const hour = (at: string) => at.slice(11, 13);
    expect(ta.describeRuns(HOURS, hour)).toBe(
      "Heating from 08, coasting from 14, cooling from 15."
    );
    expect(ta.describeRuns(HOURS.slice(6), hour)).toBe("Coasting from 14, cooling from 15.");
    expect(ta.describeRuns([], hour)).toBe("");
  });

  it("says what each event is", () => {
    const f = buildUnitContext("F").fmtTemp;
    expect(TODAY.events.map((e) => ta.describeEvent(e, f))).toEqual([
      "Banking for the peak hours begins",
      "Peak hours begin",
      "Bunk Room: schedule to 68.0°F to 74.0°F",
      "Peak hours end",
      "Craft Room: schedule to 70.0°F",
    ]);
    expect(ta.describeEvent({ at: "x", kind: "schedule", room: "Den" }, f)).toBe(
      "Den: schedule to 0.0°F"
    );
  });
});

describe("Today's Plan card", () => {
  it("shows the strip, what is coming up in the house's time, and yesterday", async () => {
    show();
    expect(screen.getByText("Loading today's plan…")).toBeInTheDocument();
    // The plan in a sentence, in the house's time: 08:00 UTC is 4 AM in New York.
    expect(
      await screen.findByText(
        "Heating from 4 AM, coasting from 10 AM, cooling from 11 AM. Low 58.0°F, high 86.0°F."
      )
    ).toBeInTheDocument();
    // One block per run of hours, as wide as the run is long, with its word in it.
    const band = screen.getByRole("img", {
      name: "Next 8 hours: 6 hours heating, 1 hour coasting, 1 hour cooling",
    });
    expect(band.children).toHaveLength(3);
    expect(band.children[0]).toHaveClass("today-heat");
    expect(band.children[0]).toHaveTextContent("Heating");
    expect(band.children[0]).toHaveStyle({ flexGrow: "6" });
    expect(band.children[0]).toHaveAttribute("title", "Heating from 4 AM, 6 hours");
    // A one-hour block is too narrow for a word; its tooltip still says.
    expect(band.children[1]).toHaveTextContent("");
    expect(band.children[1]).toHaveAttribute("title", "Coasting from 10 AM, 1 hour");
    expect(band.children[2]).toHaveClass("today-cool");
    // The outdoor line runs from now, on the left, to the last hour on the right.
    const line = screen.getByRole("img", {
      name: "Outside: 58.0°F now, low 58.0°F at 4 AM, high 86.0°F at 11 AM",
    });
    const points = line.querySelector("polyline")!.getAttribute("points")!.split(" ");
    expect(points).toHaveLength(8);
    expect(points[0]).toBe("0.0,60.0");
    expect(points[7]).toBe("720.0,10.0");
    // Times under the line; now, the low and the high carry their temperature.
    expect([...document.querySelectorAll(".today-axis span")].map((n) => n.textContent)).toEqual([
      "Now 58.0°F",
      "5 AM",
      "6 AM",
      "7 AM",
      "8 AM",
      "9 AM",
      "10 AM",
      "11 AM 86.0°F",
    ]);
    expect(
      screen.getByText(
        "Heating when it is colder than 66.0°F outside, cooling when warmer than 76.0°F: your targets."
      )
    ).toBeInTheDocument();
    const coming = within(screen.getByRole("list", { name: "Coming up" }));
    expect(coming.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "11:00 AMBanking for the peak hours begins",
      "12:00 PMPeak hours begin",
      "2:00 PMBunk Room: schedule to 68.0°F to 74.0°F",
      "3:00 PMPeak hours end",
      "5:00 AMCraft Room: schedule to 70.0°F",
    ]);
    expect(coming.getAllByRole("listitem")[0]).toHaveAttribute("title", "EDT");
    expect(screen.getByText(TODAY.yesterday)).toBeInTheDocument();
    expect(screen.getByText(/Forecast updated 4:00 AM\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tune in Smart Control" })).toHaveAttribute(
      "href",
      "/smart-control?section=forecasts"
    );
  });

  it("links through the router when it is inside one", async () => {
    render(
      <MemoryRouter>
        <TimeZoneContext.Provider value={buildTimeZoneContext("America/New_York")}>
          <TodayCard />
        </TimeZoneContext.Provider>
      </MemoryRouter>
    );
    expect(await screen.findByRole("link", { name: "Tune in Smart Control" })).toHaveAttribute(
      "href",
      "/smart-control?section=forecasts"
    );
  });

  it("draws a flat line for a day that stays at one temperature, and a single hour", async () => {
    vi.mocked(ta.getToday).mockResolvedValue({
      ...TODAY,
      forecast_fetched_at: null,
      hours: [{ at: "2026-07-06T08:00:00+00:00", temp: 70, need: "coast" }],
    });
    show();
    const line = await screen.findByRole("img", { name: /^Outside: 70\.0°F now/ });
    expect(line.querySelector("polyline")).toHaveAttribute("points", "0.0,35.0");
    expect(screen.getByText(/No forecast has been read yet\./)).toBeInTheDocument();
  });

  it("shows temperatures in the house's unit", async () => {
    show("C");
    expect(await screen.findByText(/Low 14\.4°C, high 30\.0°C\./)).toBeInTheDocument();
    expect(screen.getByText(/Bunk Room: schedule to 20\.0°C to 23\.3°C/)).toBeInTheDocument();
  });

  it("says so when there is no forecast, and still shows yesterday", async () => {
    vi.mocked(ta.getToday).mockResolvedValue({ ...TODAY, hours: [], events: [] });
    show();
    expect(await screen.findByText(/No forecast yet\./)).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText(TODAY.yesterday)).toBeInTheDocument();
  });

  it("says so when it cannot load, and keeps the last plan if a later refresh fails", async () => {
    vi.useFakeTimers();
    vi.mocked(ta.getToday).mockRejectedValueOnce(new Error("offline"));
    show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Could not load today's plan.")).toBeInTheDocument();
    // Five minutes on it is asked for again, and arrives.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(screen.getByText(TODAY.yesterday)).toBeInTheDocument();
    expect(screen.queryByText("Could not load today's plan.")).toBeNull();
    vi.mocked(ta.getToday).mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(screen.getByText(TODAY.yesterday)).toBeInTheDocument();
    expect(screen.queryByText("Could not load today's plan.")).toBeNull();
  });

  it("stops asking once it has gone", async () => {
    vi.useFakeTimers();
    const shown = show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ta.getToday).toHaveBeenCalledTimes(1);
    shown.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(ta.getToday).toHaveBeenCalledTimes(1);
  });

  it("ignores an answer that arrives after it has gone", async () => {
    let answer: (t: ta.Today) => void = () => {};
    let refuse: (e: Error) => void = () => {};
    vi.mocked(ta.getToday)
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      .mockReturnValueOnce(new Promise((_resolve, reject) => (refuse = reject)));
    const first = show();
    first.unmount();
    const second = show();
    second.unmount();
    await act(async () => {
      answer(TODAY);
      refuse(new Error("late"));
      await Promise.resolve();
    });
    expect(ta.getToday).toHaveBeenCalledTimes(2);
  });
});
