import { api } from "./api";

export type BalanceLevel = "off" | "watch" | "on";

export const BALANCE_LEVEL_LABELS: Record<BalanceLevel, string> = {
  off: "Off",
  watch: "Watch Only",
  on: "On",
};

export interface BalanceZone {
  thermostat_entity_id: string;
  name: string;
  /** °F; null with no reading. */
  temp: number | null;
  occupied: boolean;
  /** °F it is being balanced to, or null. */
  target: number | null;
  toward: string | null;
  obeyed: boolean;
}

export interface BalanceBuilding {
  building_id: string;
  name: string;
  level: BalanceLevel;
  /** How far apart zones may be: a °F difference. */
  zone_gap: number;
  direction: "heating" | "cooling" | null;
  /** Warmest less coolest, a °F difference; null with fewer than two readings. */
  spread: number | null;
  zones: BalanceZone[];
}

export interface ZoneBalance {
  buildings: BalanceBuilding[];
  min_gap: number;
  max_gap: number;
}

export const getZoneBalance = () => api<ZoneBalance>("/api/zone-balance");

/** `zone_gap` is sent in the house's display unit; the backend converts it. */
export const setZoneBalance = (
  buildingId: string,
  patch: { level?: BalanceLevel; zone_gap?: number }
) =>
  api<ZoneBalance>(`/api/zone-balance/${encodeURIComponent(buildingId)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });

/** The gap limits offered, in the display unit. */
export const GAP_CHOICES = { F: [2, 3, 4, 5, 6, 8, 10], C: [1.5, 2, 2.5, 3, 4, 5] } as const;

/** One line on what a building is doing about its zones right now. */
export function describeBalance(
  b: BalanceBuilding,
  fmtTemp: (f: number) => string,
  fmtDelta: (f: number) => string
): string {
  if (b.zones.length < 2) return "Needs two zones in the building.";
  if (b.spread === null) return "Waiting for a temperature from two zones.";
  const apart = `Zones are ${fmtDelta(b.spread)} apart.`;
  const called = b.zones.filter((z) => z.target !== null);
  if (called.length > 0) {
    const names = called.map((z) => `${z.name} to ${fmtTemp(z.target as number)}`).join(", ");
    const verb = b.direction === "cooling" ? "cooling" : "heating";
    return called[0].obeyed
      ? `${apart} Now ${verb} ${names}.`
      : `${apart} Would be ${verb} ${names} (watching only).`;
  }
  if (b.level === "off") return apart;
  if (b.direction === null)
    return `${apart} Nothing is heating or cooling here, so nothing is balanced.`;
  if (!b.zones.some((z) => z.occupied))
    return `${apart} No zone is in use, so nothing is balanced.`;
  return `${apart} Inside the limit.`;
}
