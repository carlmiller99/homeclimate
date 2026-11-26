"""Heat pump protection (HomeClimate).

A zone whose profile says ``system_type = 'heat_pump'`` gets guards that keep
the compressor doing the work so backup (aux) heat stays off. With the zone's
Auxiliary Heat setting on "Allow When Needed", the setpoint step and recovery
caps, early warm-ups and the back-off are off (heat is set like a conventional
system); runtime, airflow, switchover, defrost and Strips Expected still apply:

* **Max setpoint step**: when heating, the setpoint is never more than this
  far above the thermostat's own reading. Most thermostats call for backup heat
  on a large gap between setpoint and room temperature.
* **Max recovery rate**: during a warm-up the setpoint's ceiling climbs no
  faster than this many degrees per hour from where the cycle started.
* **Minimum run time** and **minimum open vents when heating**: floors over the
  thermostat's own settings.
* **Minimum time between heat and cool**: a cycle will not start in the
  opposite direction until this long after the last one ended.

* **Early warm-ups**: when a schedule block is about to raise a room's target,
  heating starts early enough to arrive on time at the recovery rate (up to
  three hours ahead), only while the thermostat is in heat mode.
* **Defrost allowance**: a heating cycle may run 1.5x the thermostat's cycle
  timeout, since defrost and small steps make warm-ups slower.
* **Strips Expected**: below the compressor lockout (read from the outdoor
  sensor), the compressor can't run, so warm-ups don't start early and the
  deadband widens by 1 °F to keep strip runtime down.
* **Back-off**: after backup heat runs, the setpoint step is held to 0.5 °F
  for an hour and the setpoint is re-sent at once.

Backup heat is observed, not controlled: an optional *equipment running*
source (an ecobee cloud ``climate`` entity's ``equipment_running`` attribute,
or a power sensor on the strip-heat circuit) lets HomeClimate log each backup
heat episode.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Any

from .zones import ZoneProfile

# A strip-heat power sensor reading above this many watts means strips are on.
AUX_POWER_THRESHOLD_W = 500.0
# After backup heat runs, the setpoint step is held to this for BACKOFF_MINUTES.
BACKOFF_STEP_F = 0.5
BACKOFF_MINUTES = 60
# Heat pump heating cycles may run this many times the thermostat's timeout:
# small setpoint steps and defrost make a heat pump warm-up slower.
TIMEOUT_FACTOR = 1.5
# Warm-ups start early by at most this long.
WARMUP_MAX_LEAD_HOURS = 3.0
# Below the compressor lockout ("Strips Expected"), the deadband widens by this.
STRIPS_EXTRA_DEADBAND_F = 1.0


@dataclass(frozen=True)
class HeatPumpGuards:
    max_step_f: float
    recovery_f_per_hr: float
    min_runtime_min: int
    min_open_heat_fraction: float
    switchover_gap_min: int
    compressor_lockout_f: float | None = None
    # False when the zone's Auxiliary Heat setting is "Allow When Needed".
    avoid_aux: bool = True

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
            compressor_lockout_f=zone.hp_compressor_lockout_f,
            avoid_aux=zone.hp_aux_policy == "avoid",
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
    started_at: datetime | None = None


class AuxMonitor:
    """Turns per-tick backup-heat readings into start/stop episodes."""

    def __init__(self) -> None:
        self._since: dict[str, datetime] = {}
        self._backoff_until: dict[str, datetime] = {}

    def start_backoff(self, thermostat_entity_id: str, now: datetime) -> None:
        self._backoff_until[thermostat_entity_id] = now + timedelta(minutes=BACKOFF_MINUTES)

    def backoff_active(self, thermostat_entity_id: str, now: datetime) -> bool:
        until = self._backoff_until.get(thermostat_entity_id)
        return until is not None and now < until

    def apply_backoff(
        self, thermostat_entity_id: str, guards: HeatPumpGuards, now: datetime
    ) -> HeatPumpGuards:
        """Guards with the step held to BACKOFF_STEP_F while a back-off lasts."""
        if not self.backoff_active(thermostat_entity_id, now):
            return guards
        return replace(guards, max_step_f=min(guards.max_step_f, BACKOFF_STEP_F))

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
                thermostat_entity_id,
                False,
                round((now - since).total_seconds() / 60, 1),
                started_at=since,
            )
        return None


async def record_episode(conn: Any, episode: AuxEpisode, ended_at: datetime) -> None:
    """Store a finished backup heat episode for Metrics."""
    assert episode.started_at is not None and episode.minutes is not None
    await conn.execute(
        "INSERT INTO aux_episodes(thermostat_entity_id, started_at, ended_at, minutes) "
        "VALUES(?,?,?,?)",
        (
            episode.thermostat_entity_id,
            episode.started_at.isoformat(),
            ended_at.isoformat(),
            episode.minutes,
        ),
    )
    await conn.commit()


async def aux_summary(
    conn: Any, thermostat_entity_id: str, start: datetime, end: datetime
) -> dict[str, float | int]:
    """Backup heat minutes and episode count that started within [start, end)."""
    async with conn.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(minutes), 0) AS m FROM aux_episodes "
        "WHERE thermostat_entity_id=? AND started_at>=? AND started_at<?",
        (thermostat_entity_id, start.isoformat(), end.isoformat()),
    ) as cur:
        row = await cur.fetchone()
    return {"episodes": int(row["n"]), "minutes": round(float(row["m"]), 1)}
