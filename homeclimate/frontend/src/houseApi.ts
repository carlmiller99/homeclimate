import { api } from "./api";

export interface RoomSwitches {
  /** Off: the room is not being used and asks for nothing but a hold. */
  in_use: boolean;
  /** Off: the room's schedules are skipped and it follows its targets. */
  use_schedules: boolean;
  /** Off: occupancy does not give the room its own target. */
  use_presence: boolean;
}

/** "unoccupied" is a room's When Unoccupied targets, kept beside its own. */
export type TargetScope = "building" | "zone" | "room" | "unoccupied";

/** The heating and cooling targets set at one level, in °F. */
export interface LevelTargets {
  scope: TargetScope;
  /** Building id, thermostat entity id, or room id. */
  scope_id: string;
  house_heat_to: number;
  house_cool_to: number;
}

export interface House {
  /** °F. A band left by an earlier version that no level has taken over; else null. */
  house_heat_to: number | null;
  house_cool_to: number | null;
  /** The targets set at each level. A level with none inherits from the one above. */
  targets?: LevelTargets[];
  /** °F delta required between the two. */
  min_gap: number;
  low: number;
  high: number;
  rooms: ({ room_id: string; calendar?: RoomCalendar | null } & RoomSwitches)[];
}

/** The Home Assistant calendar a room's In Use follows. */
export interface RoomCalendar {
  entity_id: string;
  /** Only events whose title contains this; empty for any event. */
  match_text: string;
  /** Minutes before an event starts that the room is already in use. */
  lead_min: number;
  /** The calendar has not answered for 30 minutes, so the room is being treated as in use. */
  unreadable?: boolean;
}

export const LEAD_MAX_MIN = 1440;

export const ALL_ON: RoomSwitches = { in_use: true, use_schedules: true, use_presence: true };

export function calendarFor(house: House | null, roomId: string): RoomCalendar | null {
  return house?.rooms.find((r) => r.room_id === roomId)?.calendar ?? null;
}

export function switchesFor(house: House | null, roomId: string): RoomSwitches {
  return house?.rooms.find((r) => r.room_id === roomId) ?? ALL_ON;
}

export const getHouse = () => api<House>("/api/house");

/** One level's own targets in °F, or null when it has none of its own. */
export function targetsFor(
  house: House | null,
  scope: TargetScope,
  scopeId: string
): { heat: number; cool: number } | null {
  const found = house?.targets?.find((t) => t.scope === scope && t.scope_id === scopeId);
  return found ? { heat: found.house_heat_to, cool: found.house_cool_to } : null;
}

/**
 * Set one level's targets. Both in the display unit, as typed; the backend
 * converts. Both null clears them, so the level follows the one above.
 */
export const setTargets = (
  scope: TargetScope,
  scopeId: string,
  heatTo: number | null,
  coolTo: number | null
) =>
  api<House>(`/api/house/targets/${scope}/${encodeURIComponent(scopeId)}`, {
    method: "PUT",
    body: JSON.stringify({ house_heat_to: heatTo, house_cool_to: coolTo }),
  });

export const setRoomSwitches = (roomId: string, data: Partial<RoomSwitches>) =>
  api<House>(`/api/house/rooms/${encodeURIComponent(roomId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const setRoomCalendar = (roomId: string, data: Partial<RoomCalendar>) =>
  api<House>(`/api/house/rooms/${encodeURIComponent(roomId)}/calendar`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const clearRoomCalendar = (roomId: string) =>
  api<House>(`/api/house/rooms/${encodeURIComponent(roomId)}/calendar`, { method: "DELETE" });
