"""Heat pump protection (HomeClimate).

A zone whose profile says ``system_type = 'heat_pump'`` gets guards that keep
the compressor doing the work so backup (aux) heat stays off:

* **Max setpoint step**: when heating, the setpoint is never more than this
  far above the thermostat's own reading. Most thermostats call for backup heat
  on a large gap between setpoint and room temperature.
* **Max recovery rate**: during a warm-up the setpoint's ceiling climbs no
  faster than this many degrees per hour from where the cycle started.
* **Minimum run time** and **minimum open vents when heating**: floors over the
  thermostat's own settings.
* **Minimum time between heat and cool**: a cycle will not start in the
  opposite direction until this long after the last one ended.

The compressor lockout temperature is stored for planning only.

Backup heat is observed, not controlled: an optional *equipment running*
source (an ecobee cloud ``climate`` entity's ``equipment_running`` attribute,
or a power sensor on the strip-heat circuit) lets HomeClimate log each backup
heat episode.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .zones import ZoneProfile

# A strip-heat power sensor reading above this many watts means strips are on.
AUX_POWER_THRESHOLD_W = 500.0


@dataclass(frozen=True)
class HeatPumpGuards:
    max_step_f: float
    recovery_f_per_hr: float
    min_runtime_min: int
    min_open_heat_fraction: float
    switchover_gap_min: int

    @classmethod
    def from_profile(cls, zone: ZoneProfile) -> HeatPumpGuards | None:
        if not zone.is_heat_pump:
            return None
        return cls(
            max_step_f=zone.hp_max_step_f,
            recovery_f_per_hr=zone.hp_recovery_f_per_hr,
            min_runtime_min=zone.hp_min_runtime_min,
            min_open_heat_fraction=zone.hp_min_open_heat_pct / 100,
            switchover_gap_min=zone.hp_switchover_gap_min,
        )


def aux_running(entity_id: str | None, state: dict | None) -> bool:
    """Whether an equipment-running source reports backup heat right now."""
    if not entity_id or not state:
        return False
    if entity_id.startswith("climate."):
        running = (state.get("attributes") or {}).get("equipment_running") or ""
        return "aux" in str(running).lower()
    value = state.get("state")
    try:
        return float(value) > AUX_POWER_THRESHOLD_W  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "aux" in str(value).lower()


@dataclass
class AuxEpisode:
    thermostat_entity_id: str
    started: bool
    minutes: float | None = None


class AuxMonitor:
    """Turns per-tick backup-heat readings into start/stop episodes."""

    def __init__(self) -> None:
        self._since: dict[str, datetime] = {}

    def running_since(self, thermostat_entity_id: str) -> datetime | None:
        return self._since.get(thermostat_entity_id)

    def update(self, thermostat_entity_id: str, running: bool, now: datetime) -> AuxEpisode | None:
        since = self._since.get(thermostat_entity_id)
        if running and since is None:
            self._since[thermostat_entity_id] = now
            return AuxEpisode(thermostat_entity_id, True)
        if not running and since is not None:
            del self._since[thermostat_entity_id]
            return AuxEpisode(
                thermostat_entity_id, False, round((now - since).total_seconds() / 60, 1)
            )
        return None
