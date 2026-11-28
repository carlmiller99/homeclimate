"""Building and zone modes: when each zone heats or cools, and how often it switches.

Each building has a mode, set on the Dashboard: ``auto``, ``heat_only``,
``cool_only`` or ``off``. Each zone has a mode of its own, also on the
Dashboard: ``follow`` (its building's), ``auto``, ``heat``, ``cool`` or ``off``.
A zone in no building that follows, or is set to Auto, chooses freely, with
no limits.

A zone in **Auto** keeps its own side, heating or cooling. It starts on the
side of its first cycle and switches when it has been waiting for the other
side and all of these hold (the limits are its building's, set in Smart
Control → Auto Mode):

- a room in the zone is the switching threshold (3 °F unless changed) past
  its target on the far side;
- no cycle of the zone's is running on its current side;
- it has waited 10 minutes;
- the building's limit allows it (``switching``, below), counted per zone;
- the forecast, if there is one, does not rule it out.

``switching`` is how often a zone may change sides, counted from its last
switch, not by the calendar:

- ``often``: 4 hours apart and at most twice a day. The forecast must need the
  new side in 2 of the next 6 hours.
- ``daily``: 24 hours apart, with the same forecast check.
- ``weekly`` / ``monthly``: 7 / 30 days apart. The forecast for the coming
  days must need the new side for more hours than the side the zone is on,
  so one warm afternoon does not spend the switch.

A zone set to Heat, Cool or Off (its own, or its building's) is on that side
and is not held to the limit.

A building can also say its zones may not run **opposite each other**. Then no
zone starts a cycle while another of the building's zones runs the other way
(a running cycle always finishes), two idle zones cannot start opposite cycles
in the same minute, and a zone in use goes before one nobody is using.

Safety cycles are never held, so a room past a safety limit is always
protected.
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
ZONE_MODES = ("follow", "auto", "heat", "cool", "off")
FIXED_SIDE = {
    "heat_only": "heating",
    "cool_only": "cooling",
    "off": "off",
    "heat": "heating",
    "cool": "cooling",
}

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
BAD_OPPOSITE = fixed("opposite_allowed must be true or false")
BAD_SWITCHING = fixed("switching must be often, daily, weekly or monthly")
BAD_THRESHOLD = fixed("The switching threshold is outside its limits")
UNKNOWN_FIELD = fixed("Unknown building mode field")
BUILDING_UNKNOWN = fixed("Building not found")


@dataclass
class BuildingMode:
    building_id: str
    mode: str = "auto"
    switching: str = "often"
    switch_threshold_f: float = DEFAULT_THRESHOLD_F
    opposite_allowed: bool = True


@dataclass
class ZoneSide:
    """The side one zone in Auto is on, and when it last switched."""

    thermostat_entity_id: str
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
                    switching=r["switching"],
                    switch_threshold_f=r["switch_threshold_f"],
                    opposite_allowed=bool(r["opposite_allowed"]),
                )
    return out


async def load_sides(conn: aiosqlite.Connection) -> dict[str, ZoneSide]:
    out: dict[str, ZoneSide] = {}
    async with conn.execute("SELECT * FROM zone_sides") as cur:
        for r in await cur.fetchall():
            out[r["thermostat_entity_id"]] = ZoneSide(
                thermostat_entity_id=r["thermostat_entity_id"],
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
        """INSERT INTO building_modes(building_id, mode, switching, switch_threshold_f,
               opposite_allowed)
               VALUES(?,?,?,?,?)
           ON CONFLICT(building_id) DO UPDATE SET mode=excluded.mode,
               switching=excluded.switching, switch_threshold_f=excluded.switch_threshold_f,
               opposite_allowed=excluded.opposite_allowed""",
        (
            m.building_id,
            m.mode,
            m.switching,
            m.switch_threshold_f,
            int(m.opposite_allowed),
        ),
    )
    await conn.commit()


async def _save_side(conn: aiosqlite.Connection, z: ZoneSide) -> None:
    await conn.execute(
        """INSERT INTO zone_sides(thermostat_entity_id, side, switched_at, switch_day, switches)
               VALUES(?,?,?,?,?)
           ON CONFLICT(thermostat_entity_id) DO UPDATE SET side=excluded.side,
               switched_at=excluded.switched_at, switch_day=excluded.switch_day,
               switches=excluded.switches""",
        (
            z.thermostat_entity_id,
            z.side,
            None if z.switched_at is None else int(z.switched_at.timestamp()),
            z.switch_day,
            z.switches,
        ),
    )
    await conn.commit()


async def _forget_side(conn: aiosqlite.Connection, thermostat_entity_id: str) -> None:
    await conn.execute(
        "DELETE FROM zone_sides WHERE thermostat_entity_id=?", (thermostat_entity_id,)
    )
    await conn.commit()


async def update(conn: aiosqlite.Connection, building_id: str, body: dict[str, Any]) -> None:
    for name, value in body.items():
        if name == "mode":
            if value not in MODES:
                raise BuildingModeError(BAD_MODE)
        elif name == "opposite_allowed":
            if not isinstance(value, bool):
                raise BuildingModeError(BAD_OPPOSITE)
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
    current.opposite_allowed = body.get("opposite_allowed", current.opposite_allowed)
    if body.get("switching", current.switching) != current.switching:
        # A new limit counts from each zone's next change, not from one made
        # (or a first side taken) under the old limit.
        await conn.execute(
            """UPDATE zone_sides SET switched_at=NULL, switch_day='', switches=0
                WHERE thermostat_entity_id IN
                      (SELECT thermostat_entity_id FROM zone_profiles WHERE building_id=?)""",
            (building_id,),
        )
    current.switching = body.get("switching", current.switching)
    if "switch_threshold" in body:
        current.switch_threshold_f = min(
            MAX_THRESHOLD_F, max(MIN_THRESHOLD_F, float(body["switch_threshold"]))
        )
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
    """What one zone is doing, as far as its side is concerned."""

    thermostat_entity_id: str
    running: str | None  # "heating" / "cooling" while a cycle runs
    wait: dict | None  # the engine's ``building_wait``
    # The cycle only protects rooms past a safety limit, or runs for nothing
    # but convenience rooms (Zone Balance and the like). Either says nothing
    # about which side the zone wants, so it never sets or switches it.
    protecting: bool = False
    # Someone is using the zone: a hold, a schedule or occupancy is asking for
    # one of its rooms. Such a zone goes first when zones may not run opposite.
    in_use: bool = False
    # The direction it wanted but could not start, because another zone of its
    # building was running (or starting) the other way.
    held_for: str | None = None


@dataclass(frozen=True)
class Decision:
    side: str | None
    obey: bool
    note: str
    switched_to: str | None = None
    # The side is a setting (Heat, Cool, Off), not a choice that a wait could
    # change.
    fixed: bool = False
    # The side the zone is about to switch to: its wait counts and only its
    # ten minutes are still running. A wait the limit, the threshold or the
    # forecast is holding back can last for weeks, and says nothing about
    # what the zone will do next.
    leaning: str | None = None


def effective_mode(zone_mode: str, building: BuildingMode | None) -> str:
    """The mode a zone runs in: its own, or its building's when it follows.

    Building modes are given in the zone's words: heat_only → heat, and so on.
    A zone in no building that follows, or is set to Auto, chooses freely.
    """
    if building is None and zone_mode in ("follow", "auto"):
        # Auto has its limits from a building; with none it chooses freely.
        return "free"
    if zone_mode != "follow":
        return zone_mode
    assert building is not None
    return {"heat_only": "heat", "cool_only": "cool"}.get(building.mode, building.mode)


OTHER = {"heating": "cooling", "cooling": "heating"}


class Planner:
    """Works out each zone's side once a minute, before the zones tick."""

    def __init__(self) -> None:
        self._decisions: dict[str, Decision] = {}
        self._zone_building: dict[str, str] = {}
        # Buildings whose zones may not run opposite each other.
        self._apart: set[str] = set()
        # This minute's starts in a building that keeps its zones apart:
        # building → (direction, first zone to claim it).
        self._claims: dict[str, tuple[str, str]] = {}
        # Zones whose claim came to nothing last time: they sit the next one out.
        self._sat_out: set[str] = set()
        # building → the direction a zone in use was held from last time. A
        # zone nobody is using does not start the other way ahead of it.
        self._first: dict[str, str] = {}
        self._in_use: dict[str, bool] = {}
        self._lock = asyncio.Lock()

    def side_for(self, thermostat_entity_id: str) -> tuple[str | None, bool]:
        """(side, obey) for a zone; (None, False) for a zone free to choose."""
        decision = self._decisions.get(thermostat_entity_id)
        return (decision.side, decision.obey) if decision else (None, False)

    def side_is_fixed(self, thermostat_entity_id: str) -> bool:
        """Whether the zone is set to one side, which no waiting changes."""
        decision = self._decisions.get(thermostat_entity_id)
        return decision is not None and decision.fixed

    def building_of(self, thermostat_entity_id: str) -> str | None:
        return self._zone_building.get(thermostat_entity_id)

    def keeps_apart(self, building_id: str | None) -> bool:
        """Whether a building's zones may not run opposite each other."""
        return building_id in self._apart

    def claim(self, thermostat_entity_id: str, direction: str) -> str | None:
        """A zone is about to start a cycle ``direction``.

        In a building whose zones may not run opposite each other, the first
        zone to start in a minute sets the direction for that minute, and a
        zone that would start the other way is told "hold". Otherwise, and for
        a zone in no building, nothing stands in the way: None.
        """
        building = self._zone_building.get(thermostat_entity_id)
        if building is None or building not in self._apart:
            return None
        if thermostat_entity_id in self._sat_out:
            # It claimed last time and then did not start. Give the other
            # zones this turn rather than block them again.
            return "hold"
        first = self._first.get(building)
        if (
            first is not None
            and first != direction
            and not self._in_use.get(thermostat_entity_id, False)
        ):
            # A zone in use is waiting to go the other way: it goes first.
            return "hold"
        claimed = self._claims.setdefault(building, (direction, thermostat_entity_id))
        return None if claimed[0] == direction else "hold"

    def live_side(
        self, thermostat_entity_id: str, running: dict[str, str]
    ) -> tuple[str | None, bool]:
        """(side, obey) for a zone, given what every zone is running right now.

        ``side`` is "hold" when the zone's building keeps its zones apart and
        another of them is running the other way: nothing new starts until
        that cycle has finished.
        """
        side, obey = self.side_for(thermostat_entity_id)
        if side == "off":
            return side, obey
        building = self._zone_building.get(thermostat_entity_id)
        if building is None or building not in self._apart:
            return side, obey
        others = {
            direction
            for tid, direction in running.items()
            if tid != thermostat_entity_id and self._zone_building.get(tid) == building
        }
        if side is None:
            if len(others) == 2:
                return "hold", True
            # Not on a side yet: it may join what the others are running.
            return (next(iter(others)) if others else None), True
        if OTHER[side] in others:
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
        """Decide every zone's side. Returns (thermostat, new side) for each switch."""
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
        profiles = {p.thermostat_entity_id: p for p in await zones.list_zone_profiles(conn)}
        self._zone_building = {tid: p.building_id for tid, p in profiles.items() if p.building_id}
        modes = await load(conn)
        self._apart = {b for b, m in modes.items() if not m.opposite_allowed}
        sides = await load_sides(conn)
        switched: list[tuple[str, str]] = []
        decisions: dict[str, Decision] = {}
        first: dict[str, str] = {}
        for z in zones_now:
            tid = z.thermostat_entity_id
            profile = profiles.get(tid)
            building_id = profile.building_id if profile else None
            building = modes.get(building_id) if building_id else None
            mode = effective_mode(profile.mode if profile else "follow", building)
            if mode != "auto" and tid in sides:
                # No longer choosing for itself. Forget its side, so that back
                # in Auto it starts from what it is doing then rather than from
                # a side chosen weeks ago.
                await _forget_side(conn, tid)
                del sides[tid]
            if mode == "free":
                continue
            if mode in FIXED_SIDE:
                decisions[tid] = Decision(FIXED_SIDE[mode], True, "", fixed=True)
            else:
                assert building is not None
                # ``band`` is each building's own targets by building id (or,
                # for a caller with one band for everything, that band).
                its_band = band.get(building_id) if isinstance(band, dict) else band
                state = sides.get(tid) or ZoneSide(tid)
                decision = await self._decide(conn, building, state, z, hours, its_band, now)
                decisions[tid] = decision
                if decision.switched_to:
                    switched.append((tid, decision.switched_to))
            if building_id in self._apart and z.in_use and z.held_for:
                first.setdefault(building_id, z.held_for)
        self._decisions = decisions
        self._first = first
        self._in_use = {z.thermostat_entity_id: z.in_use for z in zones_now}
        # A zone that claimed a start and is not running it gives way next time.
        running_now = {z.thermostat_entity_id: z.running for z in zones_now}
        self._sat_out = {tid for side, tid in self._claims.values() if running_now.get(tid) != side}
        self._claims = {}
        return switched

    async def _decide(
        self,
        conn: aiosqlite.Connection,
        m: BuildingMode,
        z: ZoneSide,
        now_doing: ZoneNow,
        hours: list[Any],
        band: Any,
        now: datetime,
    ) -> Decision:
        running = now_doing.running if not now_doing.protecting else None
        if z.side is None:
            # Not on a side yet: take the side of its first cycle.
            if running is None:
                return Decision(None, True, "")
            z.side = running
            # Taking a first side is not a switch. A seasonal limit must not
            # lock the zone for a month onto whatever ran first.
            z.switched_at = None if m.switching in SEASONAL else now
            await _save_side(conn, z)
            return Decision(z.side, True, "", switched_to=z.side)

        other = OTHER[z.side]
        wait = now_doing.wait
        if not wait or wait["direction"] != other:
            return Decision(z.side, True, "")
        if running == z.side:
            return Decision(z.side, True, f"Waiting for {z.side} to finish")
        # Only a room far enough past its target on the far side counts.
        # ``held`` is the least it has been past over the last ten minutes, so
        # one reading at the threshold cannot spend the zone's switch.
        if wait.get("held", wait.get("past", wait["excess"])) < m.switch_threshold_f - 1e-6:
            return Decision(z.side, True, f"Wants {other}; no room is far enough past its target")
        today = tz.to_local(now).date().isoformat()
        switches_today = z.switches if z.switch_day == today else 0
        # A clock set backwards must not lock the zone until it catches up.
        since_switch = (
            now - z.switched_at if z.switched_at is not None and z.switched_at <= now else None
        )
        between = BETWEEN_SWITCHES[m.switching]
        if since_switch is not None and since_switch < between:
            return Decision(
                z.side,
                True,
                f"Wants {other}; {_time_left(between - since_switch)} until it may switch",
            )
        if m.switching == "often" and switches_today >= MAX_SWITCHES_A_DAY:
            return Decision(z.side, True, f"Wants {other}; already switched twice today")
        if m.switching in SEASONAL:
            if forecast_favours(hours, other, band, now) is False:
                return Decision(
                    z.side, True, f"Wants {other}; the coming days' forecast does not favour it"
                )
        elif forecast_wants(hours, other, band, now) is False:
            return Decision(z.side, True, f"Wants {other}; the forecast does not call for it")
        if now - wait["since"] < WAIT_BEFORE_SWITCH:
            # Nothing else stands in the way: this is where it is heading.
            return Decision(z.side, True, f"Wants {other}; waiting 10 minutes", leaning=other)
        z.side = other
        z.switched_at = now
        z.switch_day = today
        z.switches = switches_today + 1
        await _save_side(conn, z)
        return Decision(other, True, "", switched_to=other)
