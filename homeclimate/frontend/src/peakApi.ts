import { api } from "./api";

export interface PeakWindow {
  bank_from: string;
  start: string;
  end: string;
  banking: boolean;
  under_way: boolean;
}

export interface PeakSettings {
  enabled: boolean;
  /** House-local HH:MM. */
  start: string;
  end: string;
  /** 0 is Monday. */
  days: number[];
  lead_min: number;
  /** How far into the band to bank: a °F difference. */
  peak_depth: number;
}

export interface PeakHours extends PeakSettings {
  window: PeakWindow | null;
  min_depth: number;
  max_depth: number;
  min_lead_min: number;
  max_lead_min: number;
}

export const getPeakHours = () => api<PeakHours>("/api/peak-hours");

/** `peak_depth` is sent in the house's display unit; the backend converts it. */
export const updatePeakHours = (patch: Partial<PeakSettings>) =>
  api<PeakHours>("/api/peak-hours", { method: "PUT", body: JSON.stringify(patch) });

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const LEAD_CHOICES = [30, 60, 90, 120, 180] as const;
/** How far to bank, offered in the display unit. */
export const DEPTH_CHOICES = { F: [1, 2, 3, 4, 5], C: [1, 1.5, 2, 2.5] } as const;

/** What is happening with the peak right now, or when the next one is. */
export function describePeak(p: PeakHours, fmt: (iso: string) => string): string {
  if (!p.enabled) return "Off: nothing is banked.";
  if (!p.window) return "No peak hours are set for any day.";
  if (p.window.under_way) return `Peak hours now, until ${fmt(p.window.end)}.`;
  if (p.window.banking) return `Banking now for the peak at ${fmt(p.window.start)}.`;
  return `Next peak ${fmt(p.window.start)}; banking starts ${fmt(p.window.bank_from)}.`;
}
