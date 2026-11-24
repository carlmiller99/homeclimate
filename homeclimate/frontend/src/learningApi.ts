import { api } from "./api";

export interface LearningSettings {
  sampling_enabled: boolean;
  sample_retention_days: number;
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
}

export interface Learning {
  settings: LearningSettings;
  samples: number;
  collecting_since: string | null;
  sample_every_min: number;
  checked_at: string;
  rooms: LearningRoom[];
}

export const RETENTION_MIN_DAYS = 30;
export const RETENTION_MAX_DAYS = 365;

/** Below this share of samples with a room temperature, the room is flagged. */
export const TEMPERATURE_WARN_BELOW_PCT = 80;

export const getLearning = () => api<Learning>("/api/learning");
export const updateLearningSettings = (data: Partial<LearningSettings>) =>
  api<Learning>("/api/learning/settings", { method: "PUT", body: JSON.stringify(data) });

/** "No data yet", "Just started", "1 day", "12.5 days". */
export function describeCollected(room: Pick<LearningRoom, "samples" | "days">): string {
  if (room.samples === 0) return "No data yet";
  if (room.days < 0.1) return "Just started";
  return room.days === 1 ? "1 day" : `${room.days} days`;
}
