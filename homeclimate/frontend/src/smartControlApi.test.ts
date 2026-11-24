import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteContactSensor,
  effectiveSettings,
  getSmartControl,
  saveContactSensor,
  setOpeningOverride,
  updateOpeningSettings,
  type SmartControl,
} from "./smartControlApi";

afterEach(() => vi.unstubAllGlobals());

describe("smartControlApi requests", () => {
  it("calls the Smart Control endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getSmartControl();
    await updateOpeningSettings({ resume_min: 1 });
    await setOpeningOverride("room", "r 1", { resume_min: null });
    await saveContactSensor("binary_sensor.a", { room_id: "r1", pauses: "room" });
    await deleteContactSensor("binary_sensor.a");
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", i?.body])).toEqual([
      ["/api/smart-control", "GET", undefined],
      ["/api/smart-control/settings", "PUT", JSON.stringify({ resume_min: 1 })],
      ["/api/smart-control/overrides/room/r%201", "PUT", JSON.stringify({ resume_min: null })],
      [
        "/api/smart-control/contacts/binary_sensor.a",
        "PUT",
        JSON.stringify({ room_id: "r1", pauses: "room" }),
      ],
      ["/api/smart-control/contacts/binary_sensor.a", "DELETE", undefined],
    ]);
  });
});

describe("helpers", () => {
  const base: SmartControl = {
    settings: {
      zone_pause_enabled: true,
      zone_pause_min: 3,
      room_pause_enabled: true,
      room_pause_min: 5,
      resume_min: 2,
    },
    overrides: [{ scope: "room", scope_id: "r1", key: "resume_min", value: 9 }],
    sensors: [],
    paused: [],
  };

  it("layers overrides over the house-wide values", () => {
    expect(effectiveSettings(base, "room", "r1")).toEqual({
      values: { ...base.settings, resume_min: 9 },
      overridden: ["resume_min"],
    });
    expect(effectiveSettings(base, "zone", "r1").overridden).toEqual([]);
  });
});
