import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFan, getFan, type FanZone } from "./fanApi";

afterEach(() => vi.unstubAllGlobals());

const Z: FanZone = {
  thermostat_entity_id: "climate.a",
  name: "Upstairs",
  level: "on",
  air_intake: "unsure",
  supported: true,
  running: false,
  note: "",
  minutes_last_hour: 0,
};

describe("fanApi", () => {
  it("calls the fan endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ zones: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getFan();
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET"])).toEqual([
      ["/api/fan", "GET"],
    ]);
  });

  it("says what a zone's fan is doing", () => {
    expect(describeFan({ ...Z, level: "off", note: "ignored" })).toBe(
      "Off. The fan is left to the thermostat."
    );
    expect(describeFan(Z)).toBe("On: nothing to mix right now.");
    expect(describeFan({ ...Z, level: "watch" })).toBe("Watching only: nothing to mix right now.");
    expect(describeFan({ ...Z, note: "Waiting 4 min after cooling" })).toBe(
      "Waiting 4 min after cooling."
    );
  });
});
