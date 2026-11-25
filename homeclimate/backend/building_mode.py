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

    def side_for(self, thermostat_entity_id: str) -> tuple[str | None, bool]:
        """(side, obey) for a zone; (None, False) for a zone in no building."""
        decision = self._decisions.get(self._zone_building.get(thermostat_entity_id, ""))
        return (decision.side, decision.obey) if decision else (None, False)

    def building_of(self, thermostat_entity_id: str) -> str | None:
        return self._zone_building.get(thermostat_entity_id)

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
        if m.mode in FIXED_SIDE:
            return Decision(FIXED_SIDE[m.mode], True, "")
        if m.auto_level == "off":
            return Decision(None, False, "")
        obey = m.auto_level == "on"
        running = {z.running for z in its_zones if z.running}
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
        if not waits:
            return Decision(m.side, obey, "")
        if m.side in running:
            return Decision(m.side, obey, f"Waiting for {m.side} to finish")
        urgent = any(w["excess"] >= URGENT_EXCESS_F for w in waits)
        today = tz.to_local(now).date().isoformat()
        switches_today = m.switches if m.switch_day == today else 0
        if not urgent:
            longest = max(now - w["since"] for w in waits)
            if longest < WAIT_BEFORE_SWITCH:
                return Decision(m.side, obey, f"A zone wants {other}; waiting 10 minutes")
            if m.switched_at is not None and now - m.switched_at < MIN_BETWEEN_SWITCHES:
                left = MIN_BETWEEN_SWITCHES - (now - m.switched_at)
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
        m.side = other
        m.switched_at = now
        m.switch_day = today
        m.switches = switches_today + 1
        await _save(conn, m)
        return Decision(other, obey, "", switched_to=other)
