import { describe, expect, it } from "vitest";
import { roomState } from "./roomState";

const band = { heat: 69, cool: 73 };
const active = (vent: string, avg: number | null = 70) => ({
  room_id: "r",
  avg_temp: avg,
  presence_active: false,
  target_temp: 70,
  vent_states: { "cover.v": vent },
});

describe("roomState", () => {
  it("is Heating or Cooling only while the cycle serves the room with an open vent", () => {
    expect(roomState(70, 1, band, active("open"), "heating")).toBe("heating");
    expect(roomState(70, 1, band, active("open"), "cooling")).toBe("cooling");
    // A served room with the thermostat idle is judged by its reading.
    expect(roomState(70, 1, band, active("open"), "idle")).toBe("at-target");
    // Vents closed: the cycle has finished with it.
    expect(roomState(68, 1, band, active("closed", 68), "heating")).toBe("below");
  });

  it("waits for readings, and says nothing without a band", () => {
    expect(roomState(undefined, undefined, band, undefined, "idle")).toBe("loading");
    expect(roomState(70, 1, null, undefined, "idle")).toBe("unknown");
    // A room in the cycle has a target of its own, even with no band.
    expect(roomState(70, 1, null, active("closed"), "idle")).toBe("at-target");
  });

  it("compares the reading with the band's edges", () => {
    expect(roomState(68.9, 1, band, undefined, "idle")).toBe("below");
    expect(roomState(69, 1, band, undefined, "idle")).toBe("at-target");
    expect(roomState(73, 1, band, undefined, "idle")).toBe("at-target");
    expect(roomState(73.1, 1, band, undefined, "idle")).toBe("above");
    expect(roomState(null, 0, band, undefined, "idle")).toBe("no-sensor");
    expect(roomState(null, 2, band, undefined, "idle")).toBe("no-reading");
  });
});
