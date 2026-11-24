/** One list drives both the desktop links and the mobile menu. */
export const NAV_ITEMS: { to: string; label: string; end?: boolean }[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/my-home", label: "My Home" },
  { to: "/smart-control", label: "Smart Control" },
  { to: "/metrics", label: "Metrics" },
  { to: "/settings", label: "Settings" },
];
