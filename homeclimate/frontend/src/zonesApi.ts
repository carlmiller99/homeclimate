import { api } from "./api";

export type SystemType = "conventional" | "heat_pump";
export type BackupHeat = "electric" | "gas" | "none";

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
}

export type ZoneProfileUpdate = Partial<Omit<ZoneProfile, "thermostat_entity_id" | "name">>;

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

export const SYSTEM_TYPE_LABELS: Record<SystemType, string> = {
  conventional: "Conventional",
  heat_pump: "Heat Pump",
};

export const BACKUP_HEAT_LABELS: Record<BackupHeat, string> = {
  electric: "Electric Strips",
  gas: "Gas (Dual Fuel)",
  none: "None",
};

/** "Heat Pump, 2 Stage, Electric Strips" — the one-line equipment summary. */
export function equipmentSummary(z: ZoneProfile): string {
  const parts = [SYSTEM_TYPE_LABELS[z.system_type]];
  if (z.compressor_stages > 1) parts.push(`${z.compressor_stages} Stage`);
  parts.push(z.backup_heat === "none" ? "No Backup Heat" : BACKUP_HEAT_LABELS[z.backup_heat]);
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
  buildings_added: number;
  rooms_added: number;
  rooms_updated: number;
  entities_added: number;
}

export const getImportPreview = () => api<ImportPreview>("/api/ha/import-preview");
export const runImport = (body: ImportRequest) =>
  api<ImportResult>("/api/ha/import", { method: "POST", body: JSON.stringify(body) });
