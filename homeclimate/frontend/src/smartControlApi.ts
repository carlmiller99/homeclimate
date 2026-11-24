import { api } from "./api";

export interface OpeningSettings {
  zone_pause_enabled: boolean;
  zone_pause_min: number;
  room_pause_enabled: boolean;
  room_pause_min: number;
  resume_min: number;
}

export type OverrideScope = "zone" | "room";
export type OverrideKey = keyof OpeningSettings;

export interface OpeningOverride {
  scope: OverrideScope;
  scope_id: string;
  key: OverrideKey;
  value: boolean | number;
}

export type ContactState = "open" | "closed" | "offline";

export interface ContactSensor {
  entity_id: string;
  name: string;
  thermostat_entity_id: string | null;
  room_id: string | null;
  pauses: "room" | "zone";
  state: ContactState;
  open_since: string | null;
  pausing: boolean;
}

export interface PausedScope {
  scope: OverrideScope;
  scope_id: string;
  since: string;
}

export interface SmartControl {
  settings: OpeningSettings;
  overrides: OpeningOverride[];
  sensors: ContactSensor[];
  paused: PausedScope[];
}

/** Where a door or window is, and whether it pauses that room or its whole zone. */
export type ContactTarget = { room_id: string; pauses: "room" | "zone" };

export const PLANNED_SECTIONS = ["Fireplace Compensation", "Smart Learning", "Forecasts"];
export const OPENINGS_NOTE =
  "Only a door or window opening starts the timer. A sensor that goes offline releases its pause.";

export const ZONE_KEYS: OverrideKey[] = ["zone_pause_enabled", "zone_pause_min", "resume_min"];
export const ROOM_KEYS: OverrideKey[] = ["room_pause_enabled", "room_pause_min", "resume_min"];

export const getSmartControl = () => api<SmartControl>("/api/smart-control");
export const updateOpeningSettings = (data: Partial<OpeningSettings>) =>
  api<SmartControl>("/api/smart-control/settings", { method: "PUT", body: JSON.stringify(data) });
export const setOpeningOverride = (
  scope: OverrideScope,
  scopeId: string,
  data: Partial<Record<OverrideKey, boolean | number | null>>
) =>
  api<SmartControl>(`/api/smart-control/overrides/${scope}/${encodeURIComponent(scopeId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
export const saveContactSensor = (entityId: string, target: ContactTarget) =>
  api<SmartControl>(`/api/smart-control/contacts/${encodeURIComponent(entityId)}`, {
    method: "PUT",
    body: JSON.stringify(target),
  });
export const deleteContactSensor = (entityId: string) =>
  api<SmartControl>(`/api/smart-control/contacts/${encodeURIComponent(entityId)}`, {
    method: "DELETE",
  });

/** Settings for one zone or room: its overrides over the house-wide values. */
export function effectiveSettings(
  data: SmartControl,
  scope: OverrideScope,
  scopeId: string
): { values: OpeningSettings; overridden: OverrideKey[] } {
  const own = data.overrides.filter((o) => o.scope === scope && o.scope_id === scopeId);
  const values = { ...data.settings } as Record<OverrideKey, boolean | number>;
  for (const o of own) values[o.key] = o.value;
  return { values: values as unknown as OpeningSettings, overridden: own.map((o) => o.key) };
}
