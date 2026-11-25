import { api } from "./api";

export interface LearningSettings {
  sampling_enabled: boolean;
  sample_retention_days: number;
}

/** How a room warms and cools, as last fitted. Rates are °F deltas per hour. */
export interface RoomModel {
  room_id: string;
  fitted_at: string | null;
  windows: number;
  hours: number;
  loss: number;
  pull: number;
  heat: number;
  cool: number;
  drift: number;
  heat_hours: number;
  cool_hours: number;
  out_spread: number;
  rmse: number | null;
  learned: { loss: boolean; pull: boolean; heat: boolean; cool: boolean };
  grade: "none" | "learning" | "ready";
}

export interface LearningRoom {
  room_id: string;
  name: string;
  thermostat_entity_id: string;
  samples: number;
  days: number;
  with_temperature_pct: number;
  first_sample_at: string | null;
  last_sample_at: string | null;
  model: RoomModel | null;
}

export interface Learning {
  settings: LearningSettings;
  samples: number;
  collecting_since: string | null;
  last_sample_at: string | null;
  sample_every_min: number;
  checked_at: string;
  rooms: LearningRoom[];
}

export const RETENTION_MIN_DAYS = 30;
export const RETENTION_MAX_DAYS = 365;

/** Below this share of samples with a room temperature, the room is flagged. */
export const TEMPERATURE_WARN_BELOW_PCT = 80;

export const getLearning = () => api<Learning>("/api/learning");
export const fitLearning = () => api<Learning>("/api/learning/fit", { method: "POST" });
export const updateLearningSettings = (data: Partial<LearningSettings>) =>
  api<Learning>("/api/learning/settings", { method: "PUT", body: JSON.stringify(data) });

/** "No data yet", "Just started", "1 day", "12.5 days". */
export function describeCollected(room: Pick<LearningRoom, "samples" | "days">): string {
  if (room.samples === 0) return "No data yet";
  if (room.days < 0.1) return "Just started";
  return room.days === 1 ? "1 day" : `${room.days} days`;
}

export const GRADE_LABELS: Record<RoomModel["grade"], string> = {
  none: "Not enough yet",
  learning: "Learning",
  ready: "Ready",
};

/**
 * What has been learned about a room, as short phrases.
 *
 * `delta` turns a °F difference into the house's unit (rates are differences
 * per hour, so no 32° offset).
 */
export function describeModel(
  m: RoomModel,
  delta: (f: number) => number,
  unitLabel: string
): string[] {
  if (m.grade === "none") {
    return ["Needs about a day of readings with nothing open and no fire lit."];
  }
  const per = (f: number) => `${Math.abs(delta(f)).toFixed(1)}${unitLabel} an hour`;
  const out = [
    m.learned.heat
      ? `Heats about ${per(m.heat)}`
      : "Heating rate not learned yet (needs about 3 hours of heating)",
    m.learned.cool
      ? `Cools about ${per(m.cool)}`
      : "Cooling rate not learned yet (needs about 3 hours of cooling)",
  ];
  // Shown per 10 °F of difference: easier to picture than a tiny coefficient.
  out.push(
    m.learned.loss
      ? `Drifts about ${per(m.loss * 10)} toward outside for every ${delta(10).toFixed(0)}${unitLabel} of difference`
      : "Heat loss not learned yet (needs more varied weather)"
  );
  return out;
}
