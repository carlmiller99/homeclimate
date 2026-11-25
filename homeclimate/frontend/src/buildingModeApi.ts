import { api } from "./api";

export type BuildingModeName = "auto" | "heat_only" | "cool_only" | "off";
export type AutoLevel = "off" | "watch" | "on";

export interface BuildingWait {
  thermostat_entity_id: string;
  /** What the zone wants: "heating" or "cooling". */
  direction: string;
  since: string;
  /** False when the side is only being watched, so nothing is actually held. */
  obeyed: boolean;
}

export interface BuildingMode {
  building_id: string;
  name: string;
  mode: BuildingModeName;
  auto_level: AutoLevel;
  /** "heating", "cooling", "off", or null when not on a side. */
  side: string | null;
  obey: boolean;
  note: string;
  waiting: BuildingWait[];
}

export const MODE_LABELS: Record<BuildingModeName, string> = {
  auto: "Auto",
  heat_only: "Heat Only",
  cool_only: "Cool Only",
  off: "Off",
};

export const AUTO_LEVEL_LABELS: Record<AutoLevel, string> = {
  off: "Off",
  watch: "Watch Only",
  on: "On",
};

export const getBuildingModes = () =>
  api<{ buildings: BuildingMode[] }>("/api/building-modes").then((r) => r.buildings);

export const setBuildingMode = (
  buildingId: string,
  data: Partial<Pick<BuildingMode, "mode" | "auto_level">>
) =>
  api<{ buildings: BuildingMode[] }>(`/api/building-modes/${encodeURIComponent(buildingId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  }).then((r) => r.buildings);

/** One line saying what a building is doing about heating and cooling. */
export function describeBuilding(b: BuildingMode): string {
  const withNote = (text: string) => (b.note ? `${text} ${b.note}.` : text);
  if (b.mode === "off") {
    return "Off. No room here asks for heating or cooling; safety limits still apply.";
  }
  if (b.mode === "heat_only") return withNote("Heating only. A room that wants cooling waits.");
  if (b.mode === "cool_only") return withNote("Cooling only. A room that wants heating waits.");
  if (b.auto_level === "off") return "Each zone chooses heating or cooling for itself.";
  if (!b.side) return "Not on a side yet; the first cycle decides.";
  const side = b.side === "heating" ? "Heating" : "Cooling";
  return withNote(
    b.auto_level === "watch" ? `Watching only: would be on ${b.side}.` : `${side} for every zone.`
  );
}
