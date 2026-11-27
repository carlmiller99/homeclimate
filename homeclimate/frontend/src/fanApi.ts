import { api } from "./api";

export type FanLevel = "off" | "watch" | "on";
export type AirIntake = "yes" | "no" | "unsure";

export interface FanZone {
  thermostat_entity_id: string;
  name: string;
  level: FanLevel;
  air_intake: AirIntake;
  /** The thermostat has an on/auto fan setting HomeClimate can switch. */
  supported: boolean;
  running: boolean;
  /** What the fan is doing, or why it is not running. */
  note: string;
  minutes_last_hour: number;
}

export interface Fan {
  zones: FanZone[];
}

export const FAN_LEVEL_LABELS: Record<FanLevel, string> = {
  off: "Off",
  watch: "Watch Only",
  on: "On",
};

export const AIR_INTAKE_LABELS: Record<AirIntake, string> = {
  yes: "Yes",
  no: "No",
  unsure: "Not Sure",
};

export const getFan = () => api<Fan>("/api/fan");

/** One line saying what a zone's fan is doing. */
export function describeFan(z: FanZone): string {
  if (z.level === "off") return "Off. The fan is left to the thermostat.";
  if (z.note) return `${z.note}.`;
  return z.level === "watch"
    ? "Watching only: nothing to mix right now."
    : "On: nothing to mix right now.";
}
