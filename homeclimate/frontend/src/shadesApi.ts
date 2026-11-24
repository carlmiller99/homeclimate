import { api } from "./api";

export const FACINGS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Facing = (typeof FACINGS)[number];

export const FACING_DEGREES: Record<Facing, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

export interface ShadeSettings {
  auto_enabled: boolean;
  skip_occupied: boolean;
  daylight_only: boolean;
  close_night_heat: boolean;
  respect_manual: boolean;
  manual_hold_min: number;
  min_move_min: number;
  quiet_hours: boolean;
  /** House-local HH:MM. */
  quiet_start: string;
  quiet_end: string;
  weather_entity: string;
}

export interface Shade {
  entity_id: string;
  name: string;
  room_id: string;
  facing: Facing;
  never_control: boolean;
  quiet_hours: boolean;
  open_position: number | null;
  closed_position: number | null;
  state: "open" | "closed" | "moving" | "unknown";
  reason: string;
  last_moved_at: string | null;
  hold_until: string | null;
}

export interface Sun {
  elevation: number | null;
  azimuth: number | null;
  cloud_pct: number | null;
}

export interface Shades {
  settings: ShadeSettings;
  sun: Sun;
  shades: Shade[];
}

export type ShadeWrite = Partial<
  Pick<
    Shade,
    "room_id" | "facing" | "never_control" | "quiet_hours" | "open_position" | "closed_position"
  >
>;

export const getShades = () => api<Shades>("/api/shades");
export const updateShadeSettings = (data: Partial<ShadeSettings>) =>
  api<Shades>("/api/shades/settings", { method: "PUT", body: JSON.stringify(data) });
export const saveShade = (entityId: string, data: ShadeWrite) =>
  api<Shades>(`/api/shades/${encodeURIComponent(entityId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
export const deleteShade = (entityId: string) =>
  api<Shades>(`/api/shades/${encodeURIComponent(entityId)}`, { method: "DELETE" });

const COMPASS = [
  "north",
  "north-northeast",
  "northeast",
  "east-northeast",
  "east",
  "east-southeast",
  "southeast",
  "south-southeast",
  "south",
  "south-southwest",
  "southwest",
  "west-southwest",
  "west",
  "west-northwest",
  "northwest",
  "north-northwest",
];

export function compassName(azimuth: number): string {
  return COMPASS[Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16];
}

/** "Sun 34° up, from the south-southeast." and friends. */
export function describeSun(sun: Sun): string {
  if (sun.elevation === null || sun.azimuth === null) return "Sun position unknown.";
  if (sun.elevation <= 0) return "The sun is down.";
  const base = `Sun ${Math.round(sun.elevation)}° up, from the ${compassName(sun.azimuth)}.`;
  return sun.cloud_pct === null ? base : `${base} Cloud cover ${Math.round(sun.cloud_pct)}%.`;
}
