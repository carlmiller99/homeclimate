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
