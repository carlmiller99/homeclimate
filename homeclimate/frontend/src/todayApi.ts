import { api } from "./api";

export type Need = "heat" | "cool" | "coast";

export interface TodayHour {
  at: string;
  /** °F, forecast outside. */
  temp: number;
  need: Need;
}

export interface TodayEvent {
  at: string;
  kind: "schedule" | "peak_bank" | "peak_start" | "peak_end";
  room_id?: string;
  room?: string;
  /** °F; schedule events only. */
  target?: number;
  /** °F; schedule blocks that set a band only. */
  cool_to?: number | null;
}

export interface Today {
  now: string;
  /** °F: colder than this outside needs heat, warmer than `cool_above` needs cooling. */
  heat_below: number;
  cool_above: number;
  forecast_fetched_at: string | null;
  hours: TodayHour[];
  events: TodayEvent[];
  yesterday: string;
}

export const getToday = () => api<Today>("/api/today");

const WORDS: Record<Need, string> = { heat: "heating", cool: "cooling", coast: "coasting" };

/** "6 hours of heating, 11 coasting, 7 of cooling", leaving out what there is none of. */
export function describeNeeds(hours: TodayHour[]): string {
  const parts = (["heat", "coast", "cool"] as const)
    .map((need) => [need, hours.filter((h) => h.need === need).length] as const)
    .filter(([, n]) => n > 0)
    .map(([need, n]) => `${n} ${n === 1 ? "hour" : "hours"} ${WORDS[need]}`);
  return parts.join(", ");
}

/**
 * The strip in words, for anyone who cannot tell its colours apart or hover
 * over it: "Heating from 4 AM, coasting from 10 AM, cooling from 11 AM."
 */
export function describeRuns(hours: TodayHour[], hour: (at: string) => string): string {
  const runs = hours
    .filter((h, i) => i === 0 || h.need !== hours[i - 1].need)
    .map((h) => `${WORDS[h.need]} from ${hour(h.at)}`);
  if (runs.length === 0) return "";
  const text = runs.join(", ");
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

/** What an event is, with temperatures already formatted for display. */
export function describeEvent(e: TodayEvent, fmtTemp: (f: number) => string): string {
  if (e.kind === "peak_bank") return "Banking for the peak hours begins";
  if (e.kind === "peak_start") return "Peak hours begin";
  if (e.kind === "peak_end") return "Peak hours end";
  const target = fmtTemp(e.target ?? 0);
  const goal = e.cool_to == null ? target : `${target} to ${fmtTemp(e.cool_to)}`;
  return `${e.room}: schedule to ${goal}`;
}
