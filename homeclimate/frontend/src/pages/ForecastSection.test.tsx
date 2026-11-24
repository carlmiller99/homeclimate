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

function data(over: Partial<fa.Forecast> = {}): fa.Forecast {
  return {
    settings: { enabled: true, weather_entity: "weather.home" },
    weather_entity: "weather.home",
    shared_with_shades: false,
    state: "fresh",
    problem: null,
    fetched_at: "2026-01-05T17:40:00+00:00",
    covers_until: "2026-01-07T17:00:00+00:00",
    days: [
      { date: "2026-01-05", starts_at: "2026-01-05T17:00:00+00:00", high: 68, low: 50, hours: 12 },
      { date: "2026-01-06", starts_at: "2026-01-06T05:00:00+00:00", high: 59, low: 41, hours: 24 },
    ],
    hours: [
      {
        at: "2026-01-05T17:00:00+00:00",
        temp: 68,
        cloud_pct: 40,
        precip_pct: 10,
        condition: "partlycloudy",
      },
      {
        at: "2026-01-05T18:00:00+00:00",
        temp: 50,
        cloud_pct: null,
        precip_pct: null,
        condition: "",
      },
    ],
    ...over,
  };
}

const OFF = data({
  settings: { enabled: false, weather_entity: "" },
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

describe("Forecasts section", () => {
  it("shows the days and the coming hours in the house's time and unit", async () => {
    show();
    expect(screen.getByText("Loading the forecast…")).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Use the Weather Forecast" })).toBeChecked();
    expect(screen.getByText(/Up to date\./)).toBeInTheDocument();
    expect(screen.getByText(/Received/)).toBeInTheDocument();
    const days = screen.getAllByRole("listitem");
    expect(days).toHaveLength(2);
    expect(within(days[0]).getByText(/Monday, Jan 5/)).toBeInTheDocument();
    expect(within(days[0]).getByText("High 68.0°F")).toBeInTheDocument();
    expect(within(days[1]).getByText("Low 41.0°F")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "Next 2 hours" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByRole("rowheader")).toHaveTextContent("12 PM");
    expect(within(rows[1]).getByText("Partly cloudy")).toBeInTheDocument();
    expect(within(rows[1]).getByText("40%")).toBeInTheDocument();
    expect(within(rows[1]).getByText("10%")).toBeInTheDocument();
    // Unknowns are dashes, not zeros.
    expect(within(rows[2]).getAllByText("—")).toHaveLength(3);
  });

  it("converts for a Celsius house", async () => {
    show("C");
    expect(await screen.findByText("High 20.0°C")).toBeInTheDocument();
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
      data({ settings: { enabled: true, weather_entity: "" }, shared_with_shades: true })
    );
    show();
    expect(await screen.findByText(/Using the weather source set for Shades/)).toBeInTheDocument();
    expect(screen.getByText("weather.home")).toBeInTheDocument();
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
