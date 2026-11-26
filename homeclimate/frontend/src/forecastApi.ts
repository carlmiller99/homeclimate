import { api } from "./api";

export interface ForecastSettings {
  enabled: boolean;
  weather_entity: string;
  /** Add each hour's usual error to the forecast once enough has been seen. */
  correct: boolean;
}

/** How the forecast has compared with the outside sensor. Differences are °F deltas. */
export interface ForecastAccuracy {
  comparisons: number;
  needed: number;
  ready: boolean;
  in_use: boolean;
  mean_error: number | null;
  mean_abs: number | null;
  mean_abs_corrected: number | null;
  by_hour: { hour: number; n: number; offset: number }[];
}

export interface ForecastDay {
  date: string;
  starts_at: string;
  high: number;
  low: number;
  hours: number;
  /** What each forecast hour of the day asks of the house, in order. */
  needs: ("heat" | "coast" | "cool")[];
  /** Home Assistant's condition id for the sky most of the day's hours share. */
  condition: string;
}

type Need = ForecastDay["needs"][number];

/** A day in a word, from what its hours ask for. */
export function dayType(needs: Need[]): "Swing" | "Warm" | "Cool" | "Mild" {
  const heat = needs.includes("heat");
  const cool = needs.includes("cool");
  return heat && cool ? "Swing" : cool ? "Warm" : heat ? "Cool" : "Mild";
}

/** Consecutive hours asking for the same thing, as [need, hours, index of first hour]. */
export function needRuns(needs: Need[]): [Need, number, number][] {
  const runs: [Need, number, number][] = [];
  needs.forEach((n, i) => {
    const last = runs[runs.length - 1];
    if (last && last[0] === n) last[1] += 1;
    else runs.push([n, 1, i]);
  });
  return runs;
}

const VERB: Record<Need, string> = { heat: "heat", coast: "coast", cool: "cool" };

/**
 * A day's plan in a sentence: "Heat until 10 AM, coast, cool from 2 PM."
 * `hourAt` names the clock hour of the day's nth forecast hour.
 */
export function dayPlan(needs: Need[], hourAt: (index: number) => string): string {
  const runs = needRuns(needs);
  if (runs.length === 0) return "";
  if (runs.length === 1) {
    return { heat: "Heat all day.", cool: "Cool all day.", coast: "No heating or cooling." }[
      runs[0][0]
    ];
  }
  const parts = runs.map(([need, , start], i) =>
    i === 0
      ? `${VERB[need]} until ${hourAt(runs[1][2])}`
      : i === runs.length - 1 || need !== "coast"
        ? `${VERB[need]} from ${hourAt(start)}`
        : VERB[need]
  );
  const text = parts.join(", ");
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

export interface ForecastHour {
  at: string;
  /** °F, corrected when the correction is in use. */
  temp: number;
  /** °F, as the weather source gave it. */
  temp_raw: number;
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
  accuracy: ForecastAccuracy;
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

/** One or two sentences on how the forecast has compared with the outside sensor. */
export function accuracyText(
  a: ForecastAccuracy,
  toDisplayDelta: (f: number) => number,
  unitLabel: string
): string {
  if (a.comparisons === 0) {
    return "Nothing to compare yet. This needs an outside temperature sensor (Settings, Sensors) and Smart Learning recording.";
  }
  const hours = `${a.comparisons} ${a.comparisons === 1 ? "hour" : "hours"}`;
  if (!a.ready || a.mean_error === null || a.mean_abs === null) {
    return `Compared ${hours} so far; the correction starts at ${a.needed}.`;
  }
  const deg = (f: number) => `${Math.abs(toDisplayDelta(f)).toFixed(1)}${unitLabel}`;
  const lean =
    Math.abs(a.mean_error) < 0.25
      ? "It leans neither warm nor cold."
      : `It usually reads ${deg(a.mean_error)} too ${a.mean_error > 0 ? "cold" : "warm"}.`;
  const base = `Over ${hours} the forecast was off by ${deg(a.mean_abs)} on average. ${lean}`;
  if (!a.in_use) return `${base} The correction is switched off.`;
  const since =
    a.mean_abs_corrected === null
      ? "The correction has just begun"
      : `Since it has been corrected, it has been off by ${deg(a.mean_abs_corrected)}`;
  return `${base} ${since}; the temperatures below include the correction.`;
}
