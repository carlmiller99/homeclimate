import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_ON,
  calendarFor,
  clearRoomCalendar,
  setRoomCalendar,
  getHouse,
  setHouseBand,
  setRoomSwitches,
  switchesFor,
  type House,
} from "./houseApi";

afterEach(() => vi.unstubAllGlobals());

describe("houseApi", () => {
  it("calls the house endpoints with the values as typed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getHouse();
    await setHouseBand(20, 24);
    await setHouseBand(null, null);
    await setRoomSwitches("r 1", { in_use: false });
    await setRoomCalendar("r 1", { entity_id: "calendar.custody" });
    await clearRoomCalendar("r 1");
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", i?.body])).toEqual([
      ["/api/house", "GET", undefined],
      ["/api/house", "PUT", JSON.stringify({ house_heat_to: 20, house_cool_to: 24 })],
      ["/api/house", "PUT", JSON.stringify({ house_heat_to: null, house_cool_to: null })],
      ["/api/house/rooms/r%201", "PUT", JSON.stringify({ in_use: false })],
      ["/api/house/rooms/r%201/calendar", "PUT", JSON.stringify({ entity_id: "calendar.custody" })],
      ["/api/house/rooms/r%201/calendar", "DELETE", undefined],
    ]);
  });

  it("treats a room with no stored switches as all on", () => {
    const house = {
      rooms: [{ room_id: "r1", in_use: false, use_schedules: true, use_presence: true }],
    } as House;
    expect(switchesFor(house, "r1").in_use).toBe(false);
    expect(switchesFor(house, "r2")).toEqual(ALL_ON);
    expect(switchesFor(null, "r1")).toEqual(ALL_ON);
    expect(calendarFor(house, "r1")).toBeNull();
    expect(calendarFor(null, "r1")).toBeNull();
    const cal = { entity_id: "calendar.custody", match_text: "", lead_min: 120 };
    expect(calendarFor({ rooms: [{ ...house.rooms[0], calendar: cal }] } as House, "r1")).toBe(cal);
  });
});
