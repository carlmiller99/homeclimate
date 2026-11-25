import { api } from "./api";

export interface ZoneSuggestion {
  kind: "deadband";
  thermostat_entity_id: string;
  name: string;
  /** °F differences. */
  current: number;
  suggested: number;
  runs_a_day: number;
  typical_run_min: number;
  days: number;
}

export interface SuggestedBlock {
  /** 0 is Monday. */
  days: number[];
  start: string;
  end: string;
}

export interface RoomSuggestion {
  kind: "schedule";
  room_id: string;
  name: string;
  days: number;
  hours_a_week: number;
  blocks: SuggestedBlock[];
}

export interface Suggestions {
  min_days: number;
  window_days: number;
  zones: ZoneSuggestion[];
  rooms: RoomSuggestion[];
}

export const getSuggestions = () => api<Suggestions>("/api/learning/suggestions");

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Mon–Fri", "Sat, Sun", "Every day", "Mon, Wed". */
export function describeDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  const run = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  return run && sorted.length > 2
    ? `${DAYS[sorted[0]]}–${DAYS[sorted[sorted.length - 1]]}`
    : sorted.map((d) => DAYS[d]).join(", ");
}

/** The deadband advice, with the history it rests on, in the house's unit. */
export function describeDeadband(
  z: ZoneSuggestion,
  toDisplayDelta: (f: number) => number,
  unitLabel: string
): string {
  const show = (f: number) => `${toDisplayDelta(f).toFixed(1)}${unitLabel}`;
  return `Over ${z.days} days it ran about ${z.runs_a_day} times a day, and half of those runs were under ${z.typical_run_min} minutes. A deadband of ${show(z.suggested)} instead of ${show(z.current)} would give fewer, longer runs. Rooms with a deadband of their own are not affected, and a minimum run time is the other way to lengthen runs.`;
}
