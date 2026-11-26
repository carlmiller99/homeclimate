"""Building mode: every zone in a building heats, or every zone cools, never both.

Each building has a mode, set on the Dashboard:

- ``auto``: HomeClimate keeps the building on one side and decides when to
  switch (below).
- ``heat_only`` / ``cool_only``: the side is fixed. A room wanting the other
  side waits.
- ``off``: the building is not in use. Nothing in it asks for heating or
  cooling; the safety limits still apply.

**Auto** has a level, set in Smart Control: ``off`` (zones choose for
themselves, as before this feature), ``watch`` (the side is worked out and
shown, and what it would have held back is logged, but nothing is held), or
``on`` (zones are held to the side).

The side starts as whatever the building's first cycle runs. It switches when
a zone has been waiting for the other side and all of these hold:

- a room in that zone is the building's switching threshold (3 °F unless
  changed) past its target on the far side;
- no cycle on the current side is running in the building;
- the zone has waited 10 minutes;
- the building's limit allows it (``switching``, below);
- the forecast, if there is one, does not rule it out.

``switching`` is how often Auto may change sides, counted from the last
switch, not by the calendar:

- ``often``: 4 hours apart and at most twice a day. The forecast must need the
  new side in 2 of the next 6 hours.
- ``daily``: 24 hours apart, with the same forecast check.
- ``weekly`` / ``monthly``: 7 / 30 days apart. The forecast for the coming
  days must need the new side for more hours than the side the building is
  on, so one warm afternoon does not spend the switch.

The limit always holds: no room, however far out, switches the building
early. Safety cycles are never held to a side, so a room past a safety limit
is still protected.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import tz, zones
from .user_errors import UserError, fixed

MODES = ("auto", "heat_only", "cool_only", "off")
AUTO_LEVELS = ("off", "watch", "on")
FIXED_SIDE = {"heat_only": "heating", "cool_only": "cooling", "off": "off"}

WAIT_BEFORE_SWITCH = timedelta(minutes=10)
MIN_BETWEEN_SWITCHES = timedelta(hours=4)
MAX_SWITCHES_A_DAY = 2
# How often Auto may change sides: the least time between two switches.
SWITCHING = ("often", "daily", "weekly", "monthly")
BETWEEN_SWITCHES = {
    "often": MIN_BETWEEN_SWITCHES,
    "daily": timedelta(hours=24),
    "weekly": timedelta(days=7),
    "monthly": timedelta(days=30),
}
# The limits long enough that a switch is a change of season, not of weather.
SEASONAL = ("weekly", "monthly")
# How far past its target on the far side (°F) a room must be before its zone's
# wait counts toward a switch.
DEFAULT_THRESHOLD_F = 3.0
MIN_THRESHOLD_F, MAX_THRESHOLD_F = 0.0, 10.0
FORECAST_LOOKAHEAD_HOURS = 6
FORECAST_HOURS_NEEDED = 2
# A seasonal switch looks this far ahead, and needs this many forecast hours
# to judge by; with fewer it has no forecast to go on.
SEASONAL_LOOKAHEAD_HOURS = 72
SEASONAL_HOURS_NEEDED = 24
# Outdoor °F below/above which an hour counts as needing heating/cooling when
# there is no house band to judge by.
DEFAULT_HEAT_BELOW_F, DEFAULT_COOL_ABOVE_F = 60.0, 70.0


class BuildingModeError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


BAD_MODE = fixed("mode must be auto, heat_only, cool_only or off")
BAD_LEVEL = fixed("auto_level must be off, watch or on")
BAD_SWITCHING = fixed("switching must be often, daily, weekly or monthly")
BAD_THRESHOLD = fixed("The switching threshold is outside its limits")
UNKNOWN_FIELD = fixed("Unknown building mode field")
BUILDING_UNKNOWN = fixed("Building not found")


@dataclass
class BuildingMode:
    building_id: str
    mode: str = "auto"
    auto_level: str = "off"
    switching: str = "often"
    switch_threshold_f: float = DEFAULT_THRESHOLD_F
    side: str | None = None
    switched_at: datetime | None = None
    switch_day: str = ""
    switches: int = 0


async def load(conn: aiosqlite.Connection) -> dict[str, BuildingMode]:
    """A mode for every building; one with no stored row has the defaults."""
    out = {b.id: BuildingMode(b.id) for b in await zones.list_buildings(conn)}
    async with conn.execute("SELECT * FROM building_modes") as cur:
        for r in await cur.fetchall():
            if r["building_id"] in out:
                out[r["building_id"]] = BuildingMode(
                    building_id=r["building_id"],
                    mode=r["mode"],
                    auto_level=r["auto_level"],
                    switching=r["switching"],
                    switch_threshold_f=r["switch_threshold_f"],
                    side=r["side"],
                    switched_at=(
                        None
                        if r["switched_at"] is None
                        else datetime.fromtimestamp(r["switched_at"], UTC)
                    ),
                    switch_day=r["switch_day"],
                    switches=r["switches"],
                )
    return out


async def _save(conn: aiosqlite.Connection, m: BuildingMode) -> None:
    await conn.execute(
        """INSERT INTO building_modes(building_id, mode, auto_level, switching,
               switch_threshold_f, side, switched_at, switch_day, switches)
               VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(building_id) DO UPDATE SET mode=excluded.mode,
               auto_level=excluded.auto_level, switching=excluded.switching,
               switch_threshold_f=excluded.switch_threshold_f, side=excluded.side,
               switched_at=excluded.switched_at, switch_day=excluded.switch_day,
               switches=excluded.switches""",
        (
            m.building_id,
            m.mode,
            m.auto_level,
            m.switching,
            m.switch_threshold_f,
            m.side,
            None if m.switched_at is None else int(m.switched_at.timestamp()),
            m.switch_day,
            m.switches,
        ),
    )
    await conn.commit()


async def update(conn: aiosqlite.Connection, building_id: str, body: dict[str, Any]) -> None:
    for name, value in body.items():
        if name == "mode":
            if value not in MODES:
                raise BuildingModeError(BAD_MODE)
        elif name == "auto_level":
            if value not in AUTO_LEVELS:
                raise BuildingModeError(BAD_LEVEL)
        elif name == "switching":
            if value not in SWITCHING:
                raise BuildingModeError(BAD_SWITCHING)
        elif name == "switch_threshold":
            # Already °F: the API converts at the write boundary.
            if (
                isinstance(value, bool)
                or not isinstance(value, int | float)
                or not math.isfinite(value)
                # A hundredth of slack: the largest value the display unit can
                # show converts back to a hair over the limit. Clamped below.
                or not MIN_THRESHOLD_F - 0.01 <= value <= MAX_THRESHOLD_F + 0.01
            ):
                raise BuildingModeError(BAD_THRESHOLD)
        else:
            raise BuildingModeError(UNKNOWN_FIELD)
    modes = await load(conn)
    if building_id not in modes:
        raise BuildingModeError(BUILDING_UNKNOWN)
    current = modes[building_id]
    current.mode = body.get("mode", current.mode)
    current.auto_level = body.get("auto_level", current.auto_level)
    if body.get("switching", current.switching) != current.switching:
        # A new limit counts from the next change, not from one made (or a
        # first side taken) under the old limit.
        current.switched_at = None
        current.switch_day, current.switches = "", 0
    current.switching = body.get("switching", current.switching)
    if "switch_threshold" in body:
        current.switch_threshold_f = min(
            MAX_THRESHOLD_F, max(MIN_THRESHOLD_F, float(body["switch_threshold"]))
        )
    if current.mode != "auto" or current.auto_level == "off":
        # Auto is no longer choosing. Forget the side it was on, so that when
        # it is turned back on it starts from what the building is doing then
        # rather than from a side chosen weeks ago.
        current.side = None
        current.switched_at = None
        current.switch_day, current.switches = "", 0
    await _save(conn, current)


def forecast_wants(hours: list[Any], side: str, band: Any, now: datetime) -> bool | None:
    """Whether the forecast needs ``side`` soon; None when there is no forecast.

    ``hours`` are ``forecast.Hour`` objects; ``band`` is the building's targets or None.
    """
    window = [h for h in hours if now <= h.at < now + timedelta(hours=FORECAST_LOOKAHEAD_HOURS)]
    if not window:
        return None
    heat_below = band.heat_to if band else DEFAULT_HEAT_BELOW_F
    cool_above = band.cool_to if band else DEFAULT_COOL_ABOVE_F
    needing = sum(
        1 for h in window if (h.temp < heat_below if side == "heating" else h.temp > cool_above)
    )
    return needing >= FORECAST_HOURS_NEEDED


def forecast_favours(hours: list[Any], side: str, band: Any, now: datetime) -> bool | None:
    """Whether the coming days need ``side`` more than the other one.

    For a switch that will not be undone for a week or a month. None when the
    forecast does not reach far enough to say.
    """
    window = [h for h in hours if now <= h.at < now + timedelta(hours=SEASONAL_LOOKAHEAD_HOURS)]
    if len(window) < SEASONAL_HOURS_NEEDED:
        return None
    heat_below = band.heat_to if band else DEFAULT_HEAT_BELOW_F
    cool_above = band.cool_to if band else DEFAULT_COOL_ABOVE_F
    heating = sum(1 for h in window if h.temp < heat_below)
    cooling = sum(1 for h in window if h.temp > cool_above)
    if not heating and not cooling:
        # Mild days that need neither side say nothing against a switch.
        return None
    return cooling > heating if side == "cooling" else heating > cooling


def _time_left(left: timedelta) -> str:
    """ "45 min", "5 hours" or "12 days": how long until a switch is allowed."""
    seconds = left.total_seconds()
    if seconds < 2 * 3600:
        return f"{int(seconds // 60) + 1} min"
    if seconds < 48 * 3600:
        return f"{math.ceil(seconds / 3600)} hours"
    return f"{math.ceil(seconds / 86400)} days"


@dataclass(frozen=True)
class ZoneNow:
    """What one zone is doing, as far as its building's side is concerned."""

    thermostat_entity_id: str
    running: str | None  # "heating" / "cooling" while a cycle runs
    wait: dict | None  # the engine's ``building_wait``
    # The cycle only protects rooms past a safety limit, or runs for nothing
    # but convenience rooms (Zone Balance and the like). Either says nothing
    # about which side the building wants, so it never sets or switches it.
    protecting: bool = False


@dataclass(frozen=True)
class Decision:
    side: str | None
    obey: bool
    note: str
    switched_to: str | None = None
    # The side is the building's setting (Heat Only, Cool Only), not a choice
    # that a waiting zone could change.
    fixed: bool = False
    # The side the building is about to switch to: a zone's wait counts and
    # only its ten minutes are still running. A wait that the limit, the
    # threshold or the forecast is holding back can last for weeks, and says
    # nothing about what the building will do next.
    leaning: str | None = None


class Planner:
    """Works out each building's side once a minute, before the zones tick."""

    def __init__(self) -> None:
        self._decisions: dict[str, Decision] = {}
        self._zone_building: dict[str, str] = {}
        self._claims: dict[str, tuple[str, str]] = {}  # building → (side, claiming zone)
        # Zones whose claim came to nothing last time: they sit the next one out.
        self._sat_out: set[str] = set()
        # When a watched building was first seen running against its side.
        self._watched_since: dict[str, tuple[str, datetime]] = {}
        self._lock = asyncio.Lock()

    def side_for(self, thermostat_entity_id: str) -> tuple[str | None, bool]:
        """(side, obey) for a zone; (None, False) for a zone in no building."""
        decision = self._decisions.get(self._zone_building.get(thermostat_entity_id, ""))
        return (decision.side, decision.obey) if decision else (None, False)

    def side_is_fixed(self, thermostat_entity_id: str) -> bool:
        """Whether the zone's building is set to one side, which no waiting changes."""
        decision = self._decisions.get(self._zone_building.get(thermostat_entity_id, ""))
        return decision is not None and decision.fixed

    def building_of(self, thermostat_entity_id: str) -> str | None:
        return self._zone_building.get(thermostat_entity_id)

    def claim(self, thermostat_entity_id: str, direction: str) -> str | None:
        """A zone is about to start the first cycle of a building with no side.

        The first zone to ask sets the side until the next plan; every zone is
        told that side. Without this, two idle zones wanting opposite sides
        would both start in the same minute. Returns None when the building is
        already on a side, is not obeyed, or the zone is in no building.
        """
        building = self._zone_building.get(thermostat_entity_id, "")
        decision = self._decisions.get(building)
        if decision is None or not decision.obey or decision.side is not None:
            return None
        if building not in self._claims:
            if thermostat_entity_id in self._sat_out:
                # It claimed the side last time and then did not start. Give
                # the other zones this turn rather than block them again.
                return "hold"
            self._claims[building] = (direction, thermostat_entity_id)
        return self._claims[building][0]

    def live_side(
        self, thermostat_entity_id: str, running: dict[str, str]
    ) -> tuple[str | None, bool]:
        """(side, obey) for a zone, given what every zone is running right now.

        ``side`` is "hold" when another zone of the building is still running
        the other way: nothing new starts until that cycle has finished.
        """
        side, obey = self.side_for(thermostat_entity_id)
        if not obey or side == "off":
            return side, obey
        building = self._zone_building[thermostat_entity_id]
        others = {
            direction
            for tid, direction in running.items()
            if tid != thermostat_entity_id and self._zone_building.get(tid) == building
        }
        if side is None:
            if len(others) == 2:
                return "hold", True
            claimed = self._claims.get(building)
            return (next(iter(others)) if others else claimed[0] if claimed else None), True
        if ("cooling" if side == "heating" else "heating") in others:
            return "hold", True
        return side, True

    def decisions(self) -> dict[str, Decision]:
        return dict(self._decisions)

    async def plan(
        self,
        conn: aiosqlite.Connection,
        zones_now: list[ZoneNow],
        hours: list[Any],
        band: Any,
        now: datetime,
    ) -> list[tuple[str, str]]:
        """Decide every building's side. Returns (building_id, new side) for each switch."""
        async with self._lock:
            return await self._plan(conn, zones_now, hours, band, now)

    async def _plan(
        self,
        conn: aiosqlite.Connection,
        zones_now: list[ZoneNow],
        hours: list[Any],
        band: Any,
        now: datetime,
    ) -> list[tuple[str, str]]:
        profiles = await zones.list_zone_profiles(conn)
        self._zone_building = {
            p.thermostat_entity_id: p.building_id for p in profiles if p.building_id
        }
        by_building: dict[str, list[ZoneNow]] = {}
        for z in zones_now:
            building = self._zone_building.get(z.thermostat_entity_id)
            if building:
                by_building.setdefault(building, []).append(z)
        switched: list[tuple[str, str]] = []
        decisions: dict[str, Decision] = {}
        for building_id, m in (await load(conn)).items():
            # ``band`` is each building's own targets by building id (or, for a
            # caller with one band for everything, that band).
            its_band = band.get(building_id) if isinstance(band, dict) else band
            decision = await self._decide(
                conn, m, by_building.get(building_id, []), hours, its_band, now
            )
            decisions[building_id] = decision
            if decision.switched_to:
                switched.append((building_id, decision.switched_to))
        self._decisions = decisions
        # A zone that claimed a side and is not running it gives way next time.
        running_now = {z.thermostat_entity_id: z.running for z in zones_now}
        self._sat_out = {tid for side, tid in self._claims.values() if running_now.get(tid) != side}
        self._claims = {}
        return switched

    async def _decide(
        self,
        conn: aiosqlite.Connection,
        m: BuildingMode,
        its_zones: list[ZoneNow],
        hours: list[Any],
        band: Any,
        now: datetime,
    ) -> Decision:
        every_cycle = {z.running for z in its_zones if z.running}
        running = {z.running for z in its_zones if z.running and not z.protecting}
        # Only kept from one plan to the next while the same thing is still seen.
        watched = self._watched_since.pop(m.building_id, None)
        if m.mode in FIXED_SIDE:
            fixed_side = FIXED_SIDE[m.mode]
            against = {"heating": "cooling", "cooling": "heating"}.get(fixed_side)
            note = f"Waiting for {against} to finish" if against in every_cycle else ""
            return Decision(fixed_side, True, note, fixed=True)
        if m.auto_level == "off":
            return Decision(None, False, "")
        obey = m.auto_level == "on"
        if m.side is None:
            # Not on a side yet: take the side of the first cycle that runs.
            if len(running) != 1:
                return Decision(None, obey, "Not on a side yet")
            m.side = running.pop()
            # Taking a first side is not a switch. A seasonal limit must not
            # lock the building for a month onto whatever ran first.
            m.switched_at = None if m.switching in SEASONAL else now
            await _save(conn, m)
            return Decision(m.side, obey, "", switched_to=m.side)

        other = "cooling" if m.side == "heating" else "heating"
        waits = [z.wait for z in its_zones if z.wait and z.wait["direction"] == other]
        if not obey and other in running:
            # Watching holds nothing, so a zone that wants the other side just
            # runs it. Count that as the wait it would have been.
            since = watched[1] if watched and watched[0] == other else now
            self._watched_since[m.building_id] = (other, since)
            # Nothing held it, so there is no telling how far it would have
            # been let go: it counts as past the threshold.
            waits.append(
                {
                    "direction": other,
                    "since": since,
                    "excess": 0.0,
                    "past": m.switch_threshold_f,
                    "obeyed": False,
                }
            )
        if not waits:
            return Decision(
                m.side, obey, f"Waiting for {other} to finish" if other in every_cycle else ""
            )
        if m.side in running:
            return Decision(m.side, obey, f"Waiting for {m.side} to finish")
        # Only a room far enough past its target on the far side counts.
        # ``held`` is the least it has been past over the last ten minutes, so
        # one reading at the threshold cannot spend the building's switch.
        waits = [
            w
            for w in waits
            if w.get("held", w.get("past", w["excess"])) >= m.switch_threshold_f - 1e-6
        ]
        if not waits:
            return Decision(
                m.side, obey, f"A zone wants {other}; no room is far enough past its target"
            )
        today = tz.to_local(now).date().isoformat()
        switches_today = m.switches if m.switch_day == today else 0
        # A clock set backwards must not lock the building until it catches up.
        since_switch = (
            now - m.switched_at if m.switched_at is not None and m.switched_at <= now else None
        )
        between = BETWEEN_SWITCHES[m.switching]
        if since_switch is not None and since_switch < between:
            return Decision(
                m.side,
                obey,
                f"A zone wants {other}; {_time_left(between - since_switch)} until a switch"
                " is allowed",
            )
        if m.switching == "often" and switches_today >= MAX_SWITCHES_A_DAY:
            return Decision(m.side, obey, f"A zone wants {other}; already switched twice today")
        if m.switching in SEASONAL:
            if forecast_favours(hours, other, band, now) is False:
                return Decision(
                    m.side,
                    obey,
                    f"A zone wants {other}; the coming days' forecast does not favour it",
                )
        elif forecast_wants(hours, other, band, now) is False:
            return Decision(
                m.side, obey, f"A zone wants {other}; the forecast does not call for it"
            )
        if max(now - w["since"] for w in waits) < WAIT_BEFORE_SWITCH:
            # Nothing else stands in the way: this is where it is heading.
            return Decision(
                m.side, obey, f"A zone wants {other}; waiting 10 minutes", leaning=other
            )
        self._watched_since.pop(m.building_id, None)
        m.side = other
        m.switched_at = now
        m.switch_day = today
        m.switches = switches_today + 1
        await _save(conn, m)
        return Decision(other, obey, "", switched_to=other)
