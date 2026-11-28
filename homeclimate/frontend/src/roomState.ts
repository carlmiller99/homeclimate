import type { ZoneStatus } from "./api";

/** How a room stands right now, for the pill beside its temperature. */
export type RoomState =
  | "loading"
  | "no-sensor"
  | "no-reading"
  | "heating"
  | "cooling"
  | "below"
  | "above"
  | "at-target"
  | "unknown";

/**
 * One room's state, from what the Dashboard can see: its reading, the band it
 * follows, and whether the running cycle is serving it with an open vent.
 */
export function roomState(
  temp: number | null | undefined,
  sensorCount: number | undefined,
  band: { heat: number; cool: number } | null,
  active: ZoneStatus["rooms"][number] | undefined,
  zoneAction: string
): RoomState {
  const served =
    active !== undefined && Object.values(active.vent_states).some((v) => v !== "closed");
  if (served && zoneAction === "heating") return "heating";
  if (served && zoneAction === "cooling") return "cooling";
  const reading = active?.avg_temp ?? temp;
  if (reading === undefined) return "loading";
  if (reading === null) return sensorCount ? "no-reading" : "no-sensor";
  if (!band) return active ? "at-target" : "unknown";
  if (reading < band.heat) return "below";
  if (reading > band.cool) return "above";
  return "at-target";
}

export const STATE_PILL: Record<RoomState, { text: string; cls: string; title: string } | null> = {
  loading: null,
  unknown: null,
  "no-sensor": {
    text: "No Sensor",
    cls: "badge-gray",
    title: "This room has no temperature sensor. Add one in My Home.",
  },
  "no-reading": {
    text: "No Reading",
    cls: "badge-orange",
    title: "None of this room's temperature sensors has reported recently.",
  },
  heating: { text: "Heating", cls: "badge-orange", title: "Being heated now, with its vent open." },
  cooling: { text: "Cooling", cls: "badge-blue", title: "Being cooled now, with its vent open." },
  below: {
    text: "Below Target",
    cls: "badge-gray",
    title: "Cooler than the temperature it is heated to.",
  },
  above: {
    text: "Above Target",
    cls: "badge-gray",
    title: "Warmer than the temperature it is cooled to.",
  },
  "at-target": {
    text: "At Target",
    cls: "badge-green",
    title: "Between the temperatures it is heated and cooled to.",
  },
};
