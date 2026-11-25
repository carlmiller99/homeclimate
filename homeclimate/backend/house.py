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

from dataclasses import dataclass, field
from typing import Any

import aiosqlite

from . import db
from .user_errors import UserError, fixed

HEAT_TO_SETTING = "house_heat_to"
COOL_TO_SETTING = "house_cool_to"
# °F. The gap keeps a heating cycle's overshoot from ever reaching cool-to.
MIN_GAP_F = 3.0
LOW_F, HIGH_F = 45.0, 95.0
SWITCHES = ("in_use", "use_schedules", "use_presence")


class HouseError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


BOTH_OR_NEITHER = fixed("Set both house_heat_to and house_cool_to, or clear both")
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


def _stored(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


async def load(conn: aiosqlite.Connection) -> House:
    heat = _stored(await db.get_system_setting(conn, HEAT_TO_SETTING, ""))
    cool = _stored(await db.get_system_setting(conn, COOL_TO_SETTING, ""))
    band = Band(heat, cool) if heat is not None and cool is not None else None
    async with conn.execute("SELECT * FROM room_switches") as cur:
        rooms = {
            r["room_id"]: RoomSwitches(
                bool(r["in_use"]), bool(r["use_schedules"]), bool(r["use_presence"])
            )
            for r in await cur.fetchall()
        }
    return House(band, rooms)


def check_band(heat_to: Any, cool_to: Any) -> str | None:
    """Why a band (in °F) is not acceptable, or None. Both None clears the band."""
    if heat_to is None and cool_to is None:
        return None
    if heat_to is None or cool_to is None:
        return BOTH_OR_NEITHER
    for value in (heat_to, cool_to):
        if isinstance(value, bool) or not isinstance(value, int | float):
            return NOT_NUMBERS
    return None


def band_in_range(heat_to: float, cool_to: float) -> bool:
    return heat_to >= LOW_F and cool_to <= HIGH_F and cool_to - heat_to >= MIN_GAP_F - 1e-6


async def set_band(
    conn: aiosqlite.Connection, heat_to: float | None, cool_to: float | None
) -> None:
    """Store the band (°F, already validated), or clear it with two Nones."""
    await db.set_system_setting(conn, HEAT_TO_SETTING, "" if heat_to is None else f"{heat_to:.2f}")
    await db.set_system_setting(conn, COOL_TO_SETTING, "" if cool_to is None else f"{cool_to:.2f}")


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
