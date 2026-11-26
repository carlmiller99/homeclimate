import { api } from "./api";

export type FanLevel = "off" | "watch" | "on";
export type AirIntake = "yes" | "no" | "unsure";

/** The last run of the outside-air test. A hint, not a finding. */
export interface FanTest {
  at: string;
  /** A cycle or a pause cut it short, so it says nothing. */
  interrupted: boolean;
  /** °F between inside and outside when it started. */
  difference?: number;
  /** °F the zone moved toward the outside temperature. */
  moved?: number;
  hint?: "possible" | "none";
}

export interface FanZone {
  thermostat_entity_id: string;
  name: string;
  level: FanLevel;
  air_intake: AirIntake;
  /** The thermostat has an on/auto fan setting HomeClimate can switch. */
  supported: boolean;
  running: boolean;
  testing: boolean;
  /** What the fan is doing, or why it is not running. */
  note: string;
  minutes_last_hour: number;
  test: FanTest | null;
}

export interface Fan {
  zones: FanZone[];
  test_minutes: number;
}

export const FAN_LEVEL_LABELS: Record<FanLevel, string> = {
  off: "Off",
  watch: "Watch Only",
  on: "On",
};

export const AIR_INTAKE_LABELS: Record<AirIntake, string> = {
  unsure: "Not Sure",
  no: "No",
  yes: "Yes",
};

export const getFan = () => api<Fan>("/api/fan");

export const testFan = (entityId: string) =>
  api<Fan>(`/api/fan/${encodeURIComponent(entityId)}/test`, { method: "POST" });

/** One line saying what a zone's fan is doing. */
export function describeFan(z: FanZone): string {
  if (z.testing) return "Testing for an outside air intake.";
  if (z.level === "off") return "Off. The fan is left to the thermostat.";
  if (z.note) return `${z.note}.`;
  return z.level === "watch"
    ? "Watching only: nothing to mix right now."
    : "On: nothing to mix right now.";
}

/** What the last outside-air test suggests, in a sentence. */
export function describeTest(
  test: FanTest | null,
  fmtDelta: (fahrenheitDelta: number) => string
): string {
  if (!test) return "Not tested yet.";
  if (test.interrupted || test.moved === undefined || test.difference === undefined) {
    return "The last test was cut short by a cycle or a pause, so it says nothing. Try again when the zone is idle.";
  }
  const moved = `With inside and outside ${fmtDelta(test.difference)} apart, the rooms moved ${fmtDelta(Math.abs(test.moved))} ${test.moved < 0 ? "away from" : "toward"} the outside temperature`;
  return test.hint === "possible"
    ? `${moved}. That could be an outside air intake, but mixing and ducts in an attic or crawl space do the same. Check the air handler for a duct to the outside.`
    : `${moved}. No sign of an outside air intake, though one with a closed damper would not show.`;
}
