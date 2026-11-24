import { api } from "./api";

export interface ForecastSettings {
  enabled: boolean;
  weather_entity: string;
}

export interface ForecastDay {
  date: string;
  starts_at: string;
  high: number;
  low: number;
  hours: number;
}

export interface ForecastHour {
  at: string;
  temp: number;
  cloud_pct: number | null;
  precip_pct: number | null;
  condition: string;
}

export type ForecastState = "off" | "no_entity" | "none" | "kept" | "fresh";

export interface Forecast {
  settings: ForecastSettings;
  weather_entity: string;
  shared_with_shades: boolean;
  state: ForecastState;
  problem: string | null;
  fetched_at: string | null;
  covers_until: string | null;
  days: ForecastDay[];
  hours: ForecastHour[];
}

export const getForecast = () => api<Forecast>("/api/forecast");
export const updateForecastSettings = (data: Partial<ForecastSettings>) =>
  api<Forecast>("/api/forecast/settings", { method: "PUT", body: JSON.stringify(data) });
export const refreshForecast = () => api<Forecast>("/api/forecast/refresh", { method: "POST" });

/** Home Assistant's condition id as words: "partlycloudy" → "Partly cloudy". */
const CONDITIONS: Record<string, string> = {
  "clear-night": "Clear",
  partlycloudy: "Partly cloudy",
  "lightning-rainy": "Thunderstorms",
  "snowy-rainy": "Sleet",
  "windy-variant": "Windy",
};
export function describeCondition(id: string): string {
  if (!id) return "";
  return CONDITIONS[id] ?? id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ");
}
