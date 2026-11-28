import { api } from "./api";

export type SystemType = "conventional" | "heat_pump";
export type BackupHeat = "electric" | "gas" | "none";

export type ZoneMode = "follow" | "auto" | "heat" | "cool" | "off";

export interface Building {
  id: string;
  name: string;
  sort_order: number;
}

export interface ZoneProfile {
  thermostat_entity_id: string;
  name: string;
  building_id: string | null;
  sort_order: number;
  system_type: SystemType;
  compressor_stages: number;
  backup_heat: BackupHeat;
  equipment_running_entity: string | null;
  heat_kit_confirmed: boolean;
  /** Heat pump protection. Temperatures arrive in °F (step and rate are deltas). */
  hp_max_step_f: number;
  hp_recovery_f_per_hr: number;
  hp_min_runtime_min: number;
  hp_min_open_heat_pct: number;
  hp_switchover_gap_min: number;
  hp_compressor_lockout_f: number | null;
  /** Auxiliary heat: "avoid" keeps setpoint gaps small; "allow" sets heat normally. */
  hp_aux_policy: "avoid" | "allow";
  /** Fan between rooms with nothing else running (Smart Control → Fan). */
  fan_level: "off" | "watch" | "on";
  /** Whether the air handler draws in outside air. "unsure" is treated as no. */
  air_intake: "yes" | "no" | "unsure";
  /** The zone's mode on the Dashboard: its building's, or its own. */
  mode: ZoneMode;
  /** True while the equipment-running source reports backup (aux) heat. */
  aux_heat_running?: boolean;
  /** True while outdoors is below the heat pump's compressor lockout. */
  strips_expected?: boolean;
  /** Set as conventional, but its thermostat shows the signs of a heat pump. */
  looks_like_heat_pump?: boolean;
}

/** What a thermostat looks like from Home Assistant's entities; a suggestion only. */
export interface EquipmentHint {
  /** "heat_pump", or null when nothing shows either way. */
  system_type: SystemType | null;
  auxiliary_heat: boolean;
  reason: "aux_switch" | "equipment_running" | null;
}

/** Writes carry temperatures in the DISPLAY unit; the backend converts (#231). */
export type ZoneProfileUpdate = Partial<
  Omit<
    ZoneProfile,
    | "thermostat_entity_id"
    | "name"
    | "aux_heat_running"
    | "strips_expected"
    | "looks_like_heat_pump"
  >
>;

export const getBuildings = () => api<Building[]>("/api/buildings");
export const createBuilding = (name: string) =>
  api<Building>("/api/buildings", { method: "POST", body: JSON.stringify({ name }) });
export const updateBuilding = (id: string, data: Partial<Omit<Building, "id">>) =>
  api<Building>(`/api/buildings/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const deleteBuilding = (id: string) =>
  api<{ deleted: string }>(`/api/buildings/${id}`, { method: "DELETE" });

export const getZones = () => api<ZoneProfile[]>("/api/zones");
export const updateZone = (entityId: string, data: ZoneProfileUpdate) =>
  api<ZoneProfile>(`/api/zones/${entityId}`, { method: "PUT", body: JSON.stringify(data) });

export const getEquipmentHint = (entityId: string) =>
  api<EquipmentHint>(`/api/ha/equipment-hint?thermostat_entity_id=${encodeURIComponent(entityId)}`);

export const SYSTEM_TYPE_LABELS: Record<SystemType, string> = {
  conventional: "Conventional",
  heat_pump: "Heat Pump",
};

export const BACKUP_HEAT_LABELS: Record<BackupHeat, string> = {
  electric: "Electric Strips",
  gas: "Gas (Dual Fuel)",
  none: "None",
};

/** The same three choices, named for a system with no heat pump: there the
 *  setting is the heat itself, not a backup. */
export const CONVENTIONAL_HEAT_LABELS: Record<BackupHeat, string> = {
  electric: "Electric Strips",
  gas: "Gas Furnace",
  none: "None",
};

/** What the heat choice is called for this kind of system. */
export const heatLabels = (system: SystemType | null) =>
  system === "heat_pump" ? BACKUP_HEAT_LABELS : CONVENTIONAL_HEAT_LABELS;

/** "Heat Pump, 2 Stage, Electric Strips" — the one-line equipment summary. */
export function equipmentSummary(z: ZoneProfile): string {
  const parts = [SYSTEM_TYPE_LABELS[z.system_type]];
  if (z.compressor_stages > 1) parts.push(`${z.compressor_stages} Stage`);
  if (z.system_type === "heat_pump") {
    parts.push(z.backup_heat === "none" ? "No Auxiliary Heat" : BACKUP_HEAT_LABELS[z.backup_heat]);
  } else {
    parts.push(z.backup_heat === "none" ? "No Heat" : CONVENTIONAL_HEAT_LABELS[z.backup_heat]);
  }
  return parts.join(", ");
}

export interface BuildingGroup<T> {
  building: Building | null;
  items: T[];
}

/**
 * Group items by building, in building order, with an "Unassigned" group
 * (building: null) last when any item has no (or an unknown) building.
 */
export function groupByBuilding<T>(
  buildings: Building[],
  items: T[],
  buildingOf: (item: T) => string | null
): BuildingGroup<T>[] {
  const known = new Set(buildings.map((b) => b.id));
  const groups: BuildingGroup<T>[] = buildings.map((b) => ({
    building: b,
    items: items.filter((i) => buildingOf(i) === b.id),
  }));
  const unassigned = items.filter((i) => {
    const b = buildingOf(i);
    return b === null || !known.has(b);
  });
  if (unassigned.length > 0) groups.push({ building: null, items: unassigned });
  return groups;
}

export interface ImportZoneRow {
  entity_id: string;
  friendly_name: string;
  area_id: string | null;
  area_name: string | null;
  floor_name: string | null;
  suggested_name: string;
  configured: boolean;
}

export interface FoundEntities {
  temperature: string[];
  presence: string[];
  contacts: string[];
  shades: string[];
  vents: string[];
}

export interface ImportRoomRow {
  area_id: string;
  area_name: string;
  found: FoundEntities;
  new_entities: string[];
  existing_room_id: string | null;
  suggested_zone: string | null;
  skipped: boolean;
}

export interface ImportPreview {
  zones: ImportZoneRow[];
  rooms: ImportRoomRow[];
  labels: Record<string, string>;
  room_names: string[];
}

export interface ImportRequest {
  zones: { entity_id: string; name: string; building_id?: string; new_building_name?: string }[];
  rooms: {
    name: string;
    zone: string;
    sensors: string[];
    presence: string[];
    vents: string[];
    contacts: string[];
  }[];
  skipped_areas: string[];
}

export interface ImportResult {
  zones_added: number;
  /** New zones set up as heat pumps because Home Assistant shows the signs. */
  heat_pumps_found: number;
  buildings_added: number;
  rooms_added: number;
  rooms_updated: number;
  entities_added: number;
}

export const getImportPreview = () => api<ImportPreview>("/api/ha/import-preview");
export const runImport = (body: ImportRequest) =>
  api<ImportResult>("/api/ha/import", { method: "POST", body: JSON.stringify(body) });

export interface AuxSummary {
  episodes: number;
  minutes: number;
}

export const getAuxSummary = (entityId: string, range: { start?: string; end?: string } = {}) => {
  const q = new URLSearchParams();
  if (range.start) q.set("start", range.start);
  if (range.end) q.set("end", range.end);
  const qs = q.toString();
  return api<AuxSummary>(
    `/api/metrics/thermostats/${encodeURIComponent(entityId)}/aux${qs ? `?${qs}` : ""}`
  );
};
