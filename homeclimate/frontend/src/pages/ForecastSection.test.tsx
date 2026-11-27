import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TimeZoneContext, UnitContext, buildTimeZoneContext, buildUnitContext } from "../contexts";
import * as fa from "../forecastApi";
import ForecastSection from "./ForecastSection";

vi.mock("../forecastApi", async (orig) => ({
  ...(await orig<typeof import("../forecastApi")>()),
  getForecast: vi.fn(),
  updateForecastSettings: vi.fn(),
  refreshForecast: vi.fn(),
}));
vi.mock("../components/EntityPicker", () => ({
  default: ({ onSelect, domain }: { onSelect: (id: string) => void; domain: string }) => (
    <button type="button" onClick={() => onSelect(`${domain}.home`)}>
      pick {domain}
    </button>
  ),
}));

const NO_ACCURACY: fa.ForecastAccuracy = {
  comparisons: 0,
  needed: 48,
  ready: false,
  in_use: false,
  mean_error: null,
  mean_abs: null,
  mean_abs_corrected: null,
  by_hour: [],
};
const LEARNED: fa.ForecastAccuracy = {
  comparisons: 120,
  needed: 48,
  ready: true,
  in_use: true,
  mean_error: 1.8,
  mean_abs: 3.6,
  mean_abs_corrected: 0.9,
  by_hour: [],
};

function data(over: Partial<fa.Forecast> = {}): fa.Forecast {
  return {
    settings: { enabled: true, weather_entity: "weather.home", correct: true },
    weather_entity: "weather.home",
    shared_with_shades: false,
    state: "fresh",
    problem: null,
    fetched_at: "2026-01-05T17:40:00+00:00",
    covers_until: "2026-01-07T17:00:00+00:00",
    days: [
      {
        date: "2026-01-05",
        starts_at: "2026-01-05T17:00:00+00:00",
        high: 68,
        low: 50,
        hours: 12,
        runs: [
          { need: "cool", at: "2026-01-05T17:00:00+00:00", hours: 4 },
          { need: "coast", at: "2026-01-05T21:00:00+00:00", hours: 3 },
          { need: "heat", at: "2026-01-06T00:00:00+00:00", hours: 5 },
        ],
        condition: "partlycloudy",
      },
      {
        date: "2026-01-06",
        starts_at: "2026-01-06T05:00:00+00:00",
        high: 59,
        low: 41,
        hours: 24,
        runs: [{ need: "heat", at: "2026-01-06T05:00:00+00:00", hours: 24 }],
        condition: "",
      },
    ],
    hours: [
      {
        at: "2026-01-05T17:00:00+00:00",
        temp: 68,
        temp_raw: 68,
        cloud_pct: 40,
        precip_pct: 10,
        condition: "partlycloudy",
      },
      {
        at: "2026-01-05T18:00:00+00:00",
        temp: 50,
        temp_raw: 50,
        cloud_pct: null,
        precip_pct: null,
        condition: "",
      },
    ],
    accuracy: NO_ACCURACY,
    ...over,
  };
}

const OFF = data({
  settings: { enabled: false, weather_entity: "", correct: true },
  weather_entity: "",
  state: "off",
  fetched_at: null,
  covers_until: null,
  days: [],
  hours: [],
});

function show(unit: "F" | "C" = "F") {
  return render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <TimeZoneContext.Provider value={buildTimeZoneContext("America/New_York")}>
        <ForecastSection />
      </TimeZoneContext.Provider>
    </UnitContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fa.getForecast).mockResolvedValue(data());
  vi.mocked(fa.updateForecastSettings).mockImplementation(async (patch) =>
    data({ settings: { ...data().settings, ...patch } })
  );
  vi.mocked(fa.refreshForecast).mockResolvedValue(data());
});

describe("describing a day", () => {
  const run = (need: fa.ForecastRun["need"], at: string, hours = 1): fa.ForecastRun => ({
    need,
    at,
    hours,
  });
  const hour = (at: string) => at;
  it("names the day from what its hours ask for", () => {
    expect(fa.dayType([run("heat", "a"), run("coast", "b"), run("cool", "c")])).toBe("Swing");
    expect(fa.dayType([run("coast", "a"), run("cool", "b")])).toBe("Warm");
    expect(fa.dayType([run("heat", "a"), run("coast", "b")])).toBe("Cool");
    expect(fa.dayType([run("coast", "a")])).toBe("Mild");
    expect(fa.dayType([])).toBe("Mild");
  });
  it("puts the plan in a sentence, naming each change by when it starts", () => {
    expect(fa.dayPlan([], hour)).toBe("");
    expect(fa.dayPlan([run("cool", "a", 24)], hour)).toBe("Cool all day.");
    expect(fa.dayPlan([run("heat", "a", 22)], hour)).toBe("Heat all day.");
    // A few hours left of a day are not the whole of it.
    expect(fa.dayPlan([run("heat", "a", 3)], hour)).toBe("Heat for these hours.");
    expect(fa.dayPlan([run("cool", "a", 1)], hour)).toBe("Cool for these hours.");
    expect(fa.dayPlan([run("coast", "a", 2)], hour)).toBe("No heating or cooling.");
    expect(
      fa.dayPlan([run("heat", "6am", 4), run("coast", "10am", 4), run("cool", "2pm")], hour)
    ).toBe("Heat until 10am, coast, cool from 2pm.");
    // A day that ends coasting says when the coasting begins.
    expect(fa.dayPlan([run("heat", "6am"), run("coast", "9am")], hour)).toBe(
      "Heat until 9am, coast from 9am."
    );
  });
});

describe("Forecasts section", () => {
  it("shows the days and the coming hours in the house's time and unit", async () => {
    show();
    expect(screen.getByText("Loading the forecast…")).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Use the Weather Forecast" })).toBeChecked();
    expect(screen.getByText(/Up to date\./)).toBeInTheDocument();
    expect(screen.getByText(/Received/)).toBeInTheDocument();
    const days = screen.getAllByRole("listitem");
    expect(days).toHaveLength(2);
    // A card per day: its name, its kind of day, its range, its sky, and the
    // plan as a bar and as a sentence, in the house's time.
    // Only the house's own today is called Today; the fixture's days are long past.
    expect(days[0]).toHaveTextContent("Monday");
    expect(within(days[0]).getByText("Swing")).toBeInTheDocument();
    expect(within(days[0]).getByText("50.0°F to 68.0°F")).toBeInTheDocument();
    expect(within(days[0]).getByText("Partly cloudy")).toBeInTheDocument();
    expect(
      [...days[0].querySelectorAll(".forecast-bar span")].map(
        (b) => `${b.className}:${(b as HTMLElement).style.flexGrow}`
      )
    ).toEqual(["forecast-cool:4", "forecast-coast:3", "forecast-heat:5"]);
    expect(
      within(days[0]).getByText("Cool until 4 PM, coast, heat from 7 PM.")
    ).toBeInTheDocument();
    expect(days[1]).toHaveTextContent("Tuesday");
    expect(screen.queryByText("Today")).toBeNull();
    expect(within(days[1]).getByText("Cool")).toBeInTheDocument();
    expect(within(days[1]).getByText("41.0°F to 59.0°F")).toBeInTheDocument();
    expect(within(days[1]).getByText("Heat all day.")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "Next 2 hours" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByRole("rowheader")).toHaveTextContent("12 PM");
    expect(within(rows[1]).getByText("Partly cloudy")).toBeInTheDocument();
    expect(within(rows[1]).getByText("40%")).toBeInTheDocument();
    expect(within(rows[1]).getByText("10%")).toBeInTheDocument();
    // Unknowns are dashes, not zeros.
    expect(within(rows[2]).getAllByText("—")).toHaveLength(3);
  });

  it("calls the house's own today Today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Noon in New York on the fixture's first day.
    vi.setSystemTime(new Date("2026-01-05T17:30:00+00:00"));
    try {
      show();
      const days = await screen.findAllByRole("listitem");
      expect(days[0]).toHaveTextContent("Today");
      expect(days[1]).toHaveTextContent("Tuesday");
    } finally {
      vi.useRealTimers();
    }
  });

  it("converts for a Celsius house", async () => {
    show("C");
    expect(await screen.findByText("10.0°C to 20.0°C")).toBeInTheDocument();
  });

  it("says what is needed when off or without a weather source", async () => {
    vi.mocked(fa.getForecast).mockResolvedValue(OFF);
    vi.mocked(fa.updateForecastSettings).mockResolvedValue({ ...OFF, state: "no_entity" });
    show();
    expect(await screen.findByText(/The forecast is off\./)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Fetch Now" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Use the Weather Forecast" }));
    await waitFor(() => expect(fa.updateForecastSettings).toHaveBeenCalledWith({ enabled: true }));
    expect(await screen.findByText(/Choose a weather source/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fetch Now" })).toBeNull();
  });

  it("picks and clears the weather source", async () => {
    vi.mocked(fa.getForecast).mockResolvedValue(OFF);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "pick weather" }));
    await waitFor(() =>
      expect(fa.updateForecastSettings).toHaveBeenCalledWith({ weather_entity: "weather.home" })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(fa.updateForecastSettings).toHaveBeenLastCalledWith({ weather_entity: "" })
    );
  });

  it("says when it is borrowing the source set for Shades", async () => {
    vi.mocked(fa.getForecast).mockResolvedValue(
      data({
        settings: { enabled: true, weather_entity: "", correct: true },
        shared_with_shades: true,
      })
    );
    show();
    expect(await screen.findByText(/Using the weather source set for Shades/)).toBeInTheDocument();
    expect(screen.getByTitle("weather.home")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "pick weather" })).toBeInTheDocument();
  });

  it("shows a kept forecast with the reason, and an empty one without a table", async () => {
    vi.mocked(fa.getForecast).mockResolvedValue(
      data({ state: "kept", problem: "Home Assistant did not return an hourly forecast." })
    );
    const first = show();
    expect(await screen.findByText(/Showing the last forecast received\./)).toBeInTheDocument();
    expect(
      screen.getByText("Home Assistant did not return an hourly forecast.")
    ).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    first.unmount();

    vi.mocked(fa.getForecast).mockResolvedValue(
      data({ state: "none", fetched_at: null, days: [], hours: [] })
    );
    show();
    expect(await screen.findByText(/No forecast yet\./)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/Received/)).toBeNull();
    expect(screen.getByRole("button", { name: "Fetch Now" })).toBeInTheDocument();
  });

  it("fetches on request, one call at a time, and reports a failure", async () => {
    let finish!: (d: fa.Forecast) => void;
    vi.mocked(fa.refreshForecast).mockReturnValueOnce(new Promise((r) => (finish = r)));
    show();
    const button = await screen.findByRole("button", { name: "Fetch Now" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(screen.getByRole("switch", { name: "Use the Weather Forecast" }));
    expect(fa.updateForecastSettings).not.toHaveBeenCalled();
    finish(data());
    await waitFor(() => expect(button).not.toBeDisabled());

    vi.mocked(fa.refreshForecast).mockRejectedValueOnce(new Error("Not allowed"));
    fireEvent.click(button);
    expect(await screen.findByText("Not allowed")).toBeInTheDocument();
    vi.mocked(fa.refreshForecast).mockRejectedValueOnce("nope");
    fireEvent.click(button);
    expect(await screen.findByText("Could not fetch the forecast")).toBeInTheDocument();
    vi.mocked(fa.updateForecastSettings).mockRejectedValueOnce("nope");
    fireEvent.click(screen.getByRole("switch", { name: "Use the Weather Forecast" }));
    expect(await screen.findByText("Could not save the setting")).toBeInTheDocument();
  });

  it("says how the forecast has compared with the outside sensor", async () => {
    show();
    expect(await screen.findByText(/Nothing to compare yet/)).toBeInTheDocument();
    const words = (a: Partial<fa.ForecastAccuracy>, unit: "F" | "C" = "F") => {
      const u = buildUnitContext(unit);
      return fa.accuracyText({ ...LEARNED, ...a }, u.toDisplayDelta, u.unitLabel);
    };
    expect(words({ comparisons: 1, ready: false })).toBe(
      "Compared 1 hour so far; the correction starts at 48."
    );
    expect(words({ comparisons: 30, ready: false })).toBe(
      "Compared 30 hours so far; the correction starts at 48."
    );
    expect(words({})).toBe(
      "Over 120 hours the forecast was off by 3.6°F on average. It usually reads 1.8°F too cold. Since it has been corrected, it has been off by 0.9°F; the temperatures below include the correction."
    );
    expect(words({ mean_error: -1.8, in_use: false })).toBe(
      "Over 120 hours the forecast was off by 3.6°F on average. It usually reads 1.8°F too warm. The correction is switched off."
    );
    expect(words({ mean_error: 0.1 })).toMatch(/It leans neither warm nor cold\./);
    // Differences are deltas: 3.6 °F is 2.0 °C, not -15.8.
    expect(words({}, "C")).toMatch(/off by 2\.0°C on average\. It usually reads 1\.0°C too cold/);
    expect(words({ mean_abs: null })).toMatch(/^Compared 120 hours so far/);
    expect(words({ mean_abs_corrected: null })).toMatch(
      /The correction has just begun; the temperatures below include the correction\.$/
    );
  });

  it("switches the correction off and on", async () => {
    vi.mocked(fa.getForecast).mockResolvedValue(data({ accuracy: LEARNED }));
    show();
    const toggle = await screen.findByRole("switch", {
      name: /Correct the Forecast From Experience/,
    });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/the temperatures below include the correction/)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(fa.updateForecastSettings).toHaveBeenCalledWith({ correct: false }));
  });

  it("says so when it cannot load, and ignores late responses", async () => {
    vi.mocked(fa.getForecast).mockRejectedValueOnce(new Error("down"));
    const first = show();
    expect(await screen.findByText("Could not load the forecast.")).toBeInTheDocument();
    first.unmount();
    let resolve!: (d: fa.Forecast) => void;
    let reject!: (e: Error) => void;
    vi.mocked(fa.getForecast)
      .mockReturnValueOnce(new Promise((r) => (resolve = r)))
      .mockReturnValueOnce(new Promise((_r, j) => (reject = j)));
    show().unmount();
    resolve(data());
    show().unmount();
    reject(new Error("late"));
    await Promise.resolve();
  });
});
