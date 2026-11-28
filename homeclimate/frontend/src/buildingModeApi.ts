import { api } from "./api";
import type { ZoneMode } from "./zonesApi";

export type BuildingModeName = "auto" | "heat_only" | "cool_only" | "off";
/** How often a zone in Auto may change sides, counted from its last change. */
export type Switching = "often" | "daily" | "weekly" | "monthly";

/** What one zone of a building is doing about heating and cooling. */
export interface ZoneModeState {
  thermostat_entity_id: string;
  name: string;
  /** The zone's own mode; "follow" takes the building's. */
  mode: ZoneMode;
  /** What it runs in. */
  effective_mode: "auto" | "heat" | "cool" | "off";
  /** "heating", "cooling", "off", or null when not on a side yet. */
  side: string | null;
  /** Why a switch it wants has not happened yet, or "". */
  note: string;
  /** When an Auto zone may next switch (UTC), or null. */
  next_switch_at: string | null;
  /** The side it is waiting to switch to, or null. */
  waiting: string | null;
  /** The way it could not start, because another zone runs the other way. */
  held_for: string | null;
  in_use: boolean;
}

export interface BuildingMode {
  building_id: string;
  name: string;
  mode: BuildingModeName;
  /** Whether the building's zones may heat and cool at the same time. */
  opposite_allowed: boolean;
  switching: Switching;
  /** °F difference: how far past its target on the other side a room must be. */
  switch_threshold: number;
  zones: ZoneModeState[];
}

export const MODE_LABELS: Record<BuildingModeName, string> = {
  auto: "Auto",
  heat_only: "Heat Only",
  cool_only: "Cool Only",
  off: "Off",
};

export const ZONE_MODE_LABELS: Record<ZoneMode, string> = {
  follow: "Follow Building",
  auto: "Auto",
  heat: "Heat",
  cool: "Cool",
  off: "Off",
};

export const SWITCHING_LABELS: Record<Switching, string> = {
  often: "Several Times a Day",
  daily: "Once a Day",
  weekly: "Once a Week",
  monthly: "Once a Month",
};

/** The switching threshold's limits, as °F differences (backend/building_mode.py). */
export const THRESHOLD_MIN_F = 0;
export const THRESHOLD_MAX_F = 10;

export const getBuildingModes = () =>
  api<{ buildings: BuildingMode[] }>("/api/building-modes").then((r) => r.buildings);

export const setBuildingMode = (
  buildingId: string,
  /** `switch_threshold` goes as typed, in the display unit; the backend converts. */
  data: Partial<Pick<BuildingMode, "mode" | "opposite_allowed" | "switching" | "switch_threshold">>
) =>
  api<{ buildings: BuildingMode[] }>(`/api/building-modes/${encodeURIComponent(buildingId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  }).then((r) => r.buildings);

const SIDE_WORD: Record<string, string> = { heating: "heats", cooling: "cools" };

/** A zone's mode, said in a few words: "Follows Main House", "Set to Cool". */
export function describeZoneMode(z: ZoneModeState, buildingName: string): string {
  if (z.mode === "follow") return `Follows ${buildingName}`;
  return z.mode === "auto" ? "Auto" : `Set to ${ZONE_MODE_LABELS[z.mode]}`;
}

/**
 * One line on what a building is doing about heating and cooling: its mode,
 * and any zone waiting for another to finish running the other way.
 */
export function describeBuilding(b: BuildingMode): string {
  if (b.mode === "off") {
    return "Off. No room here asks for heating or cooling; safety limits still apply.";
  }
  const lead = {
    auto: "Auto.",
    heat_only: "Heat Only.",
    cool_only: "Cool Only.",
  }[b.mode];
  const running = b.zones.filter((z) => z.held_for === null && z.side !== null);
  const held = b.zones
    .filter((z) => z.held_for !== null)
    .map((z) => {
      const other = running.find((r) => r.side !== z.held_for && r.side !== "off");
      const by = other ? ` while ${other.name} ${SIDE_WORD[other.side as string] ?? "runs"}` : "";
      return `${z.name} waits${by}.`;
    });
  return [lead, ...held].join(" ");
}

/** The mode word shown on a zone's card: "Follows Main House", "Auto", "Cool". */
export function zoneModeWord(mode: ZoneMode, buildingName: string | null): string {
  if (mode === "follow") return buildingName ? `Follows ${buildingName}` : "Auto";
  return ZONE_MODE_LABELS[mode];
}

/**
 * Why a zone is not doing what its mode asks, in a sentence, or null when
 * nothing is holding it back.
 */
export function zoneWaitText(z: ZoneModeState, b: BuildingMode): string | null {
  const lead = z.mode === "follow" ? "" : `Set to ${ZONE_MODE_LABELS[z.mode]}. `;
  if (z.held_for !== null) {
    const other = b.zones.find(
      (r) =>
        r.thermostat_entity_id !== z.thermostat_entity_id &&
        r.held_for === null &&
        r.side !== null &&
        r.side !== "off" &&
        r.side !== z.held_for
    );
    const by = other ? ` while ${other.name} ${SIDE_WORD[other.side as string] ?? "runs"}` : "";
    return `${lead}Waits${by}, because zones in ${b.name} may not run opposite each other.`;
  }
  return z.note ? `${lead}${z.note}.` : null;
}
