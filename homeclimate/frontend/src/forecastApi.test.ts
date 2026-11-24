import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeCondition,
  getForecast,
  refreshForecast,
  updateForecastSettings,
} from "./forecastApi";

afterEach(() => vi.unstubAllGlobals());

describe("forecastApi", () => {
  it("calls the forecast endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getForecast();
    await updateForecastSettings({ enabled: true });
    await refreshForecast();
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", i?.body])).toEqual([
      ["/api/forecast", "GET", undefined],
      ["/api/forecast/settings", "PUT", JSON.stringify({ enabled: true })],
      ["/api/forecast/refresh", "POST", undefined],
    ]);
  });

  it("puts weather conditions into words", () => {
    expect(describeCondition("")).toBe("");
    expect(describeCondition("partlycloudy")).toBe("Partly cloudy");
    expect(describeCondition("sunny")).toBe("Sunny");
    expect(describeCondition("snowy-heavy")).toBe("Snowy heavy");
  });
});
