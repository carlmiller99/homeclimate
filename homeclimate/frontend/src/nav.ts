/** One list drives both the desktop links and the mobile menu. */
export const NAV_ITEMS: { to: string; label: string; end?: boolean }[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/rooms", label: "Rooms" },
  { to: "/schedules", label: "Schedules" },
  { to: "/zones", label: "Zones" },
  { to: "/metrics", label: "Metrics" },
  { to: "/logs", label: "Logs" },
  { to: "/settings", label: "Settings" },
];
