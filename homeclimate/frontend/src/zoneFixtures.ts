/** Heat pump protection defaults, as the backend returns them (°F). For tests. */
export const HP_DEFAULTS = {
  hp_max_step_f: 1,
  hp_recovery_f_per_hr: 2,
  hp_min_runtime_min: 15,
  hp_min_open_heat_pct: 50,
  hp_switchover_gap_min: 60,
  hp_compressor_lockout_f: null,
  hp_aux_policy: "avoid" as const,
};

/** Fan defaults, as the backend returns them. For tests. */
export const FAN_DEFAULTS = {
  fan_level: "off" as const,
  air_intake: "unsure" as const,
};

/** A zone profile for a thermostat, as GET /api/zones returns it. For tests. */
export const zoneFor = (thermostat_entity_id: string, name = "") => ({
  thermostat_entity_id,
  name,
  building_id: null,
  sort_order: 0,
  system_type: "conventional" as const,
  compressor_stages: 1,
  backup_heat: "electric" as const,
  equipment_running_entity: null,
  heat_kit_confirmed: false,
  ...HP_DEFAULTS,
  ...FAN_DEFAULTS,
});

/** GET /api/smart-control with the house defaults and the given sensors. For tests. */
export const smartControl = (sensors: unknown[] = []) => ({
  settings: {
    zone_pause_enabled: true,
    zone_pause_min: 3,
    room_pause_enabled: true,
    room_pause_min: 5,
    resume_min: 2,
  },
  overrides: [],
  sensors,
  paused: [],
});
