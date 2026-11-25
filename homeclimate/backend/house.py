"""The house band, and the per-room switches that decide what a room follows.

**The house band** is one heat-to and one cool-to temperature for the whole
house, set on the Dashboard. A room with nothing more specific to follow is
held inside it: heated when it falls below heat-to, cooled when it rises above
cool-to, left alone in between. With no house band set, such a room asks for
nothing, exactly as before this feature existed.

**Per-room switches** decide what may give a room its own target instead:

- ``in_use``: off means the room is not being used. It asks for no heating or
  cooling, and its schedules and occupancy sensors are ignored. A hold still
  works, and the safety limits still apply.
- ``use_schedules``: off means the room's schedules are skipped (not deleted)
  and it follows the house band instead.
- ``use_presence``: off means occupancy does not give the room its own target.

Temperatures are °F here; the API converts at its write boundary.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import aiosqlite

from . import db
from .user_errors import UserError, fixed

# Both edges in one setting ("68.00,74.00"), so a reader never sees half a change.
BAND_SETTING = "house_band"
# °F. A band narrower than this is no longer two different targets once the
# deadband on each edge is counted.
MIN_GAP_F = 3.0
# °F a band edge must stay inside a zone's safety limits, so a cycle working
# toward it can always finish.
SAFETY_MARGIN_F = 1.0
LOW_F, HIGH_F = 45.0, 95.0
SWITCHES = ("in_use", "use_schedules", "use_presence")


class HouseError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


BOTH_OR_NEITHER = fixed("Send both house_heat_to and house_cool_to: two numbers, or two nulls")
NOT_NUMBERS = fixed("house_heat_to and house_cool_to must be numbers")
UNKNOWN_SWITCH = fixed("Unknown room switch")
SWITCH_NOT_BOOL = fixed("Room switches must be true or false")
ROOM_UNKNOWN = fixed("Room not found")


@dataclass(frozen=True)
class Band:
    heat_to: float
    cool_to: float

    def target_for(self, mode: str | None, temp: float | None) -> float:
        """The single target the engine works to.

        In a heating cycle that is heat-to and in a cooling cycle cool-to. With
        no cycle running it is the room's own temperature held inside the band,
        so a room in the band reads as at target and one outside it reads as
        short of the nearer edge.
        """
        if mode == "heating":
            return self.heat_to
        if mode == "cooling":
            return self.cool_to
        if temp is None:
            return self.heat_to
        return min(max(temp, self.heat_to), self.cool_to)


@dataclass(frozen=True)
class RoomSwitches:
    in_use: bool = True
    use_schedules: bool = True
    use_presence: bool = True


@dataclass(frozen=True)
class House:
    band: Band | None = None
    rooms: dict[str, RoomSwitches] = field(default_factory=dict)

    def switches(self, room_id: str) -> RoomSwitches:
        return self.rooms.get(room_id, RoomSwitches())


def _stored(value: str) -> Band | None:
    try:
        heat, cool = (float(part) for part in value.split(","))
    except ValueError:
        return None
    # Anything that is not a usable band is no band.
    return Band(heat, cool) if band_in_range(heat, cool) else None


async def load(conn: aiosqlite.Connection) -> House:
    band = _stored(await db.get_system_setting(conn, BAND_SETTING, ""))
    async with conn.execute("SELECT * FROM room_switches") as cur:
        rooms = {
            r["room_id"]: RoomSwitches(
                bool(r["in_use"]), bool(r["use_schedules"]), bool(r["use_presence"])
            )
            for r in await cur.fetchall()
        }
    return House(band, rooms)


def check_band(body: dict[str, Any]) -> str | None:
    """Why a request body is not a band or a clear, or None.

    Both keys must be present: two numbers set the band, two nulls clear it.
    """
    if "house_heat_to" not in body or "house_cool_to" not in body:
        return BOTH_OR_NEITHER
    heat_to, cool_to = body["house_heat_to"], body["house_cool_to"]
    if heat_to is None and cool_to is None:
        return None
    if heat_to is None or cool_to is None:
        return BOTH_OR_NEITHER
    for value in (heat_to, cool_to):
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or abs(value) > 1000
            or not math.isfinite(value)
        ):
            return NOT_NUMBERS
    return None


def band_in_range(heat_to: float, cool_to: float) -> bool:
    return heat_to >= LOW_F and cool_to <= HIGH_F and cool_to - heat_to >= MIN_GAP_F - 1e-6


async def safety_window(conn: aiosqlite.Connection) -> tuple[float, float]:
    """(highest heat-to, lowest cool-to) every zone's safety limits allow, in °F.

    Heating toward heat-to needs a setpoint below the zone's maximum, and
    cooling toward cool-to one above its minimum; outside that a cycle could
    never finish.
    """
    configs = await db.get_all_thermostat_configs(conn)
    top = min((tc.max_setpoint for tc in configs), default=HIGH_F + SAFETY_MARGIN_F)
    bottom = max((tc.min_setpoint for tc in configs), default=LOW_F - SAFETY_MARGIN_F)
    return top - SAFETY_MARGIN_F, bottom + SAFETY_MARGIN_F


async def set_band(
    conn: aiosqlite.Connection, heat_to: float | None, cool_to: float | None
) -> None:
    """Store the band (°F, already validated), or clear it with two Nones."""
    value = "" if heat_to is None or cool_to is None else f"{heat_to:.2f},{cool_to:.2f}"
    await db.set_system_setting(conn, BAND_SETTING, value)


async def set_switches(conn: aiosqlite.Connection, room_id: str, body: dict[str, Any]) -> None:
    for name, value in body.items():
        if name not in SWITCHES:
            raise HouseError(UNKNOWN_SWITCH)
        if not isinstance(value, bool):
            raise HouseError(SWITCH_NOT_BOOL)
    if await db.get_room(conn, room_id) is None:
        raise HouseError(ROOM_UNKNOWN)
    await conn.execute("INSERT OR IGNORE INTO room_switches(room_id) VALUES(?)", (room_id,))
    for name, value in body.items():
        # Column names come from SWITCHES, never from the request.
        await conn.execute(
            f"UPDATE room_switches SET {name} = ? WHERE room_id = ?", (int(value), room_id)
        )
    await conn.commit()
