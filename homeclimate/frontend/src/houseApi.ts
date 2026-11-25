import { api } from "./api";

export interface RoomSwitches {
  /** Off: the room is not being used and asks for nothing but a hold. */
  in_use: boolean;
  /** Off: the room's schedules are skipped and it follows the house band. */
  use_schedules: boolean;
  /** Off: occupancy does not give the room its own target. */
  use_presence: boolean;
}

export interface House {
  /** °F, or null when no house band is set. */
  house_heat_to: number | null;
  house_cool_to: number | null;
  /** °F delta required between the two. */
  min_gap: number;
  low: number;
  high: number;
  rooms: ({ room_id: string } & RoomSwitches)[];
}

export const ALL_ON: RoomSwitches = { in_use: true, use_schedules: true, use_presence: true };

export function switchesFor(house: House | null, roomId: string): RoomSwitches {
  return house?.rooms.find((r) => r.room_id === roomId) ?? ALL_ON;
}

export const getHouse = () => api<House>("/api/house");

/** Both in the display unit, as typed; the backend converts. Both null clears the band. */
export const setHouseBand = (heatTo: number | null, coolTo: number | null) =>
  api<House>("/api/house", {
    method: "PUT",
    body: JSON.stringify({ house_heat_to: heatTo, house_cool_to: coolTo }),
  });

export const setRoomSwitches = (roomId: string, data: Partial<RoomSwitches>) =>
  api<House>(`/api/house/rooms/${encodeURIComponent(roomId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
