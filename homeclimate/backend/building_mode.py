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

- no cycle on the current side is running in the building;
- the zone has waited 10 minutes;
- it is 4 hours since the last switch;
- there have been fewer than 2 switches today;
- the forecast, if there is one, needs the new side in 2 of the next 6 hours.

A room 2 °F past its target on the far side switches at once (after any
running cycle ends). Safety cycles are never held to a side.
"""

from __future__ import annotations

import asyncio
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
URGENT_EXCESS_F = 2.0
# An urgent switch skips the ordinary limits but keeps looser ones of its own,
# so two zones that want opposite sides cannot flip the building all day.
URGENT_WAIT = timedelta(minutes=3)
URGENT_MIN_BETWEEN_SWITCHES = timedelta(hours=1)
URGENT_MAX_SWITCHES_A_DAY = 6
FORECAST_LOOKAHEAD_HOURS = 6
FORECAST_HOURS_NEEDED = 2
# Outdoor °F below/above which an hour counts as needing heating/cooling when
# there is no house band to judge by.
DEFAULT_HEAT_BELOW_F, DEFAULT_COOL_ABOVE_F = 60.0, 70.0


class BuildingModeError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


BAD_MODE = fixed("mode must be auto, heat_only, cool_only or off")
BAD_LEVEL = fixed("auto_level must be off, watch or on")
UNKNOWN_FIELD = fixed("Unknown building mode field")
BUILDING_UNKNOWN = fixed("Building not found")


@dataclass
class BuildingMode:
    building_id: str
    mode: str = "auto"
    auto_level: str = "off"
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
        """INSERT INTO building_modes(building_id, mode, auto_level, side, switched_at,
               switch_day, switches) VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(building_id) DO UPDATE SET mode=excluded.mode,
               auto_level=excluded.auto_level, side=excluded.side,
               switched_at=excluded.switched_at, switch_day=excluded.switch_day,
               switches=excluded.switches""",
        (
            m.building_id,
            m.mode,
            m.auto_level,
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
        else:
            raise BuildingModeError(UNKNOWN_FIELD)
    modes = await load(conn)
    if building_id not in modes:
        raise BuildingModeError(BUILDING_UNKNOWN)
    current = modes[building_id]
    current.mode = body.get("mode", current.mode)
    current.auto_level = body.get("auto_level", current.auto_level)
    if current.mode != "auto" or current.auto_level == "off":
        # Auto is no longer choosing. Forget the side it was on, so that when
        # it is turned back on it starts from what the building is doing then
        # rather than from a side chosen weeks ago.
        current.side = None
        current.switched_at = None
    await _save(conn, current)


def forecast_wants(hours: list[Any], side: str, band: Any, now: datetime) -> bool | None:
    """Whether the forecast needs ``side`` soon; None when there is no forecast.

    ``hours`` are ``forecast.Hour`` objects; ``band`` is the house band or None.
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


@dataclass(frozen=True)
class ZoneNow:
    """What one zone is doing, as far as its building's side is concerned."""

    thermostat_entity_id: str
    running: str | None  # "heating" / "cooling" while a cycle runs
    wait: dict | None  # the engine's ``building_wait``
    # The cycle only protects rooms past a safety limit. It says nothing about
    # which side the building wants, so it never sets or switches the side.
    protecting: bool = False


@dataclass(frozen=True)
class Decision:
    side: str | None
    obey: bool
    note: str
    switched_to: str | None = None


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
            decision = await self._decide(
                conn, m, by_building.get(building_id, []), hours, band, now
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
            return Decision(fixed_side, True, note)
        if m.auto_level == "off":
            return Decision(None, False, "")
        obey = m.auto_level == "on"
        if m.side is None:
            # Not on a side yet: take the side of the first cycle that runs.
            if len(running) != 1:
                return Decision(None, obey, "Not on a side yet")
            m.side = running.pop()
            m.switched_at = now
            await _save(conn, m)
            return Decision(m.side, obey, "", switched_to=m.side)

        other = "cooling" if m.side == "heating" else "heating"
        waits = [z.wait for z in its_zones if z.wait and z.wait["direction"] == other]
        if not obey and other in running:
            # Watching holds nothing, so a zone that wants the other side just
            # runs it. Count that as the wait it would have been.
            since = watched[1] if watched and watched[0] == other else now
            self._watched_since[m.building_id] = (other, since)
            waits.append({"direction": other, "since": since, "excess": 0.0, "obeyed": False})
        if not waits:
            return Decision(
                m.side, obey, f"Waiting for {other} to finish" if other in every_cycle else ""
            )
        if m.side in running:
            return Decision(m.side, obey, f"Waiting for {m.side} to finish")
        today = tz.to_local(now).date().isoformat()
        switches_today = m.switches if m.switch_day == today else 0
        # A clock set backwards must not lock the building until it catches up.
        since_switch = (
            now - m.switched_at if m.switched_at is not None and m.switched_at <= now else None
        )
        urgent = (
            any(w["excess"] >= URGENT_EXCESS_F and now - w["since"] >= URGENT_WAIT for w in waits)
            and (since_switch is None or since_switch >= URGENT_MIN_BETWEEN_SWITCHES)
            and switches_today < URGENT_MAX_SWITCHES_A_DAY
        )
        if not urgent:
            longest = max(now - w["since"] for w in waits)
            if longest < WAIT_BEFORE_SWITCH:
                return Decision(m.side, obey, f"A zone wants {other}; waiting 10 minutes")
            if since_switch is not None and since_switch < MIN_BETWEEN_SWITCHES:
                left = MIN_BETWEEN_SWITCHES - since_switch
                mins = int(left.total_seconds() // 60) + 1
                return Decision(
                    m.side, obey, f"A zone wants {other}; {mins} min until a switch is allowed"
                )
            if switches_today >= MAX_SWITCHES_A_DAY:
                return Decision(m.side, obey, f"A zone wants {other}; already switched twice today")
            if forecast_wants(hours, other, band, now) is False:
                return Decision(
                    m.side, obey, f"A zone wants {other}; the forecast does not call for it"
                )
        self._watched_since.pop(m.building_id, None)
        m.side = other
        m.switched_at = now
        m.switch_day = today
        m.switches = switches_today + 1
        await _save(conn, m)
        return Decision(other, obey, "", switched_to=other)
