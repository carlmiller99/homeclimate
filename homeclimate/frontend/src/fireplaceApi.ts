import { api } from "./api";

export type FireplaceControl = "off" | "on";
export type FireplaceState = "lit" | "cooling" | "out" | "unknown";

export interface Fireplace {
  id: string;
  name: string;
  entity_id: string;
  room_ids: string[];
  cooldown_min: number;
  control: FireplaceControl;
  state: FireplaceState;
  lit_since: string | null;
  cooling_until: string | null;
  setting_aside: boolean;
  /** Held as cooling because its signal stopped reporting while lit. */
  signal_lost: boolean;
}

export type FireplaceWrite = Partial<
  Pick<Fireplace, "name" | "entity_id" | "room_ids" | "cooldown_min" | "control">
>;

export interface Fireplaces {
  fireplaces: Fireplace[];
}

/** Entity kinds that can say the fire is lit. Mirrors SIGNAL_DOMAINS in backend/fireplace.py. */
export const SIGNAL_DOMAINS = [
  "switch",
  "binary_sensor",
  "input_boolean",
  "light",
  "fan",
  "climate",
];
export const COOLDOWN_MAX_MIN = 240;

export const STATE_LABELS: Record<FireplaceState, string> = {
  lit: "Lit",
  cooling: "Cooling Down",
  out: "Out",
  unknown: "Not Reporting",
};

export const getFireplaces = () => api<Fireplaces>("/api/fireplaces");
export const addFireplace = (data: FireplaceWrite) =>
  api<Fireplaces>("/api/fireplaces", { method: "POST", body: JSON.stringify(data) });
export const saveFireplace = (id: string, data: FireplaceWrite) =>
  api<Fireplaces>(`/api/fireplaces/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
export const deleteFireplace = (id: string) =>
  api<Fireplaces>(`/api/fireplaces/${encodeURIComponent(id)}`, { method: "DELETE" });
