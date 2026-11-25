import type { Section } from "./components/SectionLayout";
import { PLANNED_SECTIONS } from "./smartControlApi";

export const SMART_CONTROL_SECTIONS: Section[] = [
  { id: "schedules", label: "Schedules" },
  { id: "doors-windows", label: "Doors & Windows" },
  { id: "smart-learning", label: "Smart Learning" },
  { id: "forecasts", label: "Forecasts" },
  { id: "fireplace", label: "Fireplace" },
  { id: "eco-mode", label: "Eco Mode" },
  ...PLANNED_SECTIONS.map((label) => ({ id: label, label, planned: true })),
];

export const SETTINGS_SECTIONS: Section[] = [
  { id: "general", label: "General" },
  { id: "sensors", label: "Sensors" },
  { id: "integrations", label: "Integrations" },
  { id: "notifications", label: "Notifications" },
  { id: "logs", label: "Logs" },
  { id: "dev-mode", label: "Dev Mode" },
];
