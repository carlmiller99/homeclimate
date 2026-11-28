"""Zone Balance: keeping the zones of one building within a few degrees of each other.

When one zone of a building is in use and another has been left to drift, the
gap between them grows until the used zone is heating (or cooling) the other
through the walls and doors. With Zone Balance on for a building, a zone more
than the gap limit behind another, occupied, zone gets a balancing call: just
enough to bring it back to the limit, and only in the direction the building
is already working in.

The rules, all here:

* only a building with a known direction (its side under One Side Per
  Building, or the way its zones are running now) is balanced;
* the comparison is with zones somebody is using: a zone asked for by a hold,
  a schedule or occupancy. An empty building is never balanced;
* a zone's temperature is the average of its rooms that are in use and have a
  reading. Rooms set aside for a lit fireplace are left out;
* the call asks for the minimum: the other zone's temperature less the limit
  (plus it, when cooling), to the nearest half degree.

The engine (``CycleEngine._balance``) adds the rooms; it leaves holds,
schedules and occupancy alone, and pauses still apply. Temperatures are °F.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import aiosqlite

from .user_errors import UserError, fixed

LEVELS = ("off", "on")
DEFAULT_GAP_F = 3.0
MIN_GAP_F = 2.0
MAX_GAP_F = 10.0


class ZoneBalanceError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


BUILDING_UNKNOWN = fixed("building_id does not match a building")
UNKNOWN_FIELD = fixed("Only level and zone_gap can be set")
BAD_LEVEL = fixed("level must be off or on")
BAD_GAP = fixed("The gap limit must be between 2 and 10 °F (1.2 and 5.5 °C)")


@dataclass
class Setting:
    building_id: str
    level: str = "off"
    gap: float = DEFAULT_GAP_F


async def load(conn: aiosqlite.Connection) -> dict[str, Setting]:
    """Every building's setting; a building never set has the defaults."""
    async with conn.execute(
        "SELECT b.id, z.level, z.gap FROM buildings b LEFT JOIN zone_balance z"
        " ON z.building_id = b.id"
    ) as cur:
        rows = await cur.fetchall()
    return {
        r["id"]: Setting(
            r["id"],
            r["level"] if r["level"] in LEVELS else "off",
            DEFAULT_GAP_F if r["gap"] is None else r["gap"],
        )
        for r in rows
    }


async def update(conn: aiosqlite.Connection, building_id: str, body: dict[str, Any]) -> None:
    """Set a building's level and gap limit. ``zone_gap`` is already °F."""
    for name, value in body.items():
        if name == "level":
            if value not in LEVELS:
                raise ZoneBalanceError(BAD_LEVEL)
        elif name == "zone_gap":
            if (
                isinstance(value, bool)
                or not isinstance(value, int | float)
                or not MIN_GAP_F <= value <= MAX_GAP_F
            ):
                raise ZoneBalanceError(BAD_GAP)
        else:
            raise ZoneBalanceError(UNKNOWN_FIELD)
    settings = await load(conn)
    if building_id not in settings:
        raise ZoneBalanceError(BUILDING_UNKNOWN)
    current = settings[building_id]
    await conn.execute(
        "INSERT INTO zone_balance(building_id, level, gap) VALUES(?,?,?)"
        " ON CONFLICT(building_id) DO UPDATE SET level = excluded.level, gap = excluded.gap",
        (
            building_id,
            body.get("level", current.level),
            float(body.get("zone_gap", current.gap)),
        ),
    )
    await conn.commit()


@dataclass(frozen=True)
class ZoneState:
    """One zone, as far as balancing is concerned."""

    thermostat_entity_id: str
    temp: float | None  # average of its in-use rooms with a reading
    occupied: bool  # a hold, a schedule or occupancy is asking for it


@dataclass(frozen=True)
class Call:
    """A balancing call for one zone."""

    mode: str  # "heating" or "cooling"
    target: float
    toward: str  # the thermostat of the zone it is being kept near
    behind: float  # how far apart the two are


def decide(zones: list[ZoneState], direction: str | None, gap: float) -> dict[str, Call]:
    """Which zones of one building get a balancing call, and to what."""
    if direction not in ("heating", "cooling"):
        return {}
    calls: dict[str, Call] = {}
    for zone in zones:
        if zone.temp is None:
            continue
        others = [
            z
            for z in zones
            if z.occupied
            and z.temp is not None
            and z.thermostat_entity_id != zone.thermostat_entity_id
        ]
        if not others:
            continue
        heating = direction == "heating"
        lead = (max if heating else min)(others, key=lambda z: z.temp or 0.0)
        assert lead.temp is not None
        behind = lead.temp - zone.temp if heating else zone.temp - lead.temp
        if behind > gap:
            target = lead.temp - gap if heating else lead.temp + gap
            calls[zone.thermostat_entity_id] = Call(
                direction, round(target * 2) / 2, lead.thermostat_entity_id, round(behind, 1)
            )
    return calls


def spread(zones: list[ZoneState]) -> float | None:
    """Warmest less coolest among the zones with a temperature; None with fewer than two."""
    temps = [z.temp for z in zones if z.temp is not None]
    return round(max(temps) - min(temps), 1) if len(temps) >= 2 else None
