import { api } from "./api";

export interface NotifySettings {
  enabled: boolean;
  /** A Home Assistant notify service, e.g. "notify.mobile_app_my_phone", or "". */
  service: string;
  level: "warning" | "error";
  categories: string[];
  daily_summary: boolean;
  /** Hour of the day in the house's time zone, 0 to 23. */
  summary_hour: number;
  in_dev_mode: boolean;
}

export interface Notifications {
  settings: NotifySettings;
  categories: { id: string; label: string }[];
  last_send_failed: boolean;
}

export const getNotifications = () => api<Notifications>("/api/notifications");
export const updateNotifySettings = (data: Partial<NotifySettings>) =>
  api<Notifications>("/api/notifications/settings", { method: "PUT", body: JSON.stringify(data) });
export const sendTestNotification = () =>
  api<Notifications>("/api/notifications/test", { method: "POST" });

/** "7 AM", "12 PM", "9 PM": an hour of the day, for the summary time picker. */
export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}
