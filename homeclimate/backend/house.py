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
  Instead of being set by hand it can follow a Home Assistant calendar: the
  room is in use while an event is on, and from a set lead time before one
  starts so it is ready on arrival.
- ``use_schedules``: off means the room's schedules are skipped (not deleted)
  and it follows the house band instead.
- ``use_presence``: off means occupancy does not give the room its own target.

Temperatures are °F here; the API converts at its write boundary.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

import aiosqlite

from . import db, tz
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
BAD_CALENDAR = fixed("entity_id must be a calendar entity")
BAD_MATCH = fixed("match_text must be text of up to 60 characters")
BAD_LEAD = fixed("lead_min must be a whole number of minutes from 0 to 1440")
UNKNOWN_CALENDAR_FIELD = fixed("Unknown calendar field")
CALENDAR_NEEDS_ENTITY = fixed("Choose the calendar this room follows")
IN_USE_FOLLOWS_CALENDAR = fixed(
    "This room's In Use follows a calendar; stop following it to set it by hand"
)
LEAD_DEFAULT_MIN, LEAD_MAX_MIN, MATCH_MAX = 120, 1440, 60


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
class RoomCalendar:
    """The calendar a room's "in use" follows, and what it last said."""

    entity_id: str
    match_text: str = ""
    lead_min: int = LEAD_DEFAULT_MIN
    in_use: bool = True


@dataclass(frozen=True)
class House:
    band: Band | None = None
    rooms: dict[str, RoomSwitches] = field(default_factory=dict)
    calendars: dict[str, RoomCalendar] = field(default_factory=dict)

    def switches(self, room_id: str) -> RoomSwitches:
        """A room's switches, with "in use" taken from its calendar if it follows one."""
        found = self.rooms.get(room_id, RoomSwitches())
        calendar = self.calendars.get(room_id)
        if calendar is None:
            return found
        return RoomSwitches(calendar.in_use, found.use_schedules, found.use_presence)


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
    async with conn.execute("SELECT * FROM room_calendars") as cur:
        calendars = {
            r["room_id"]: RoomCalendar(
                r["entity_id"], r["match_text"], r["lead_min"], bool(r["in_use"])
            )
            for r in await cur.fetchall()
        }
    return House(band, rooms, calendars)


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
    if "in_use" in body and room_id in (await load(conn)).calendars:
        raise HouseError(IN_USE_FOLLOWS_CALENDAR)
    await conn.execute("INSERT OR IGNORE INTO room_switches(room_id) VALUES(?)", (room_id,))
    for name, value in body.items():
        # Column names come from SWITCHES, never from the request.
        await conn.execute(
            f"UPDATE room_switches SET {name} = ? WHERE room_id = ?", (int(value), room_id)
        )
    await conn.commit()


async def set_calendar(conn: aiosqlite.Connection, room_id: str, body: dict[str, Any]) -> None:
    """Make a room's "in use" follow a calendar, or change how it does."""
    for name, value in body.items():
        if name == "entity_id":
            ok = isinstance(value, str) and value.startswith("calendar.") and len(value) > 9
            if not ok:
                raise HouseError(BAD_CALENDAR)
        elif name == "match_text":
            if not isinstance(value, str) or len(value) > MATCH_MAX:
                raise HouseError(BAD_MATCH)
        elif name == "lead_min":
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not 0 <= value <= LEAD_MAX_MIN
            ):
                raise HouseError(BAD_LEAD)
        else:
            raise HouseError(UNKNOWN_CALENDAR_FIELD)
    if await db.get_room(conn, room_id) is None:
        raise HouseError(ROOM_UNKNOWN)
    async with conn.execute("SELECT 1 FROM room_calendars WHERE room_id = ?", (room_id,)) as cur:
        exists = await cur.fetchone() is not None
    if not exists:
        if "entity_id" not in body:
            raise HouseError(CALENDAR_NEEDS_ENTITY)
        # Until the calendar is first read, the room keeps the state it had by hand.
        current = (await load(conn)).switches(room_id).in_use
        await conn.execute(
            "INSERT INTO room_calendars(room_id, entity_id, in_use) VALUES(?,?,?)",
            (room_id, body["entity_id"], int(current)),
        )
    for name, value in body.items():
        # Column names come from the fixed set checked above, never from the request.
        text = value.strip() if name == "match_text" else value
        await conn.execute(
            f"UPDATE room_calendars SET {name} = ? WHERE room_id = ?", (text, room_id)
        )
    await conn.commit()


async def clear_calendar(conn: aiosqlite.Connection, room_id: str) -> bool:
    """Stop following a calendar. The room keeps, by hand, the state it had."""
    async with conn.execute(
        "SELECT in_use FROM room_calendars WHERE room_id = ?", (room_id,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return False
    await conn.execute("INSERT OR IGNORE INTO room_switches(room_id) VALUES(?)", (room_id,))
    await conn.execute(
        "UPDATE room_switches SET in_use = ? WHERE room_id = ?", (row["in_use"], room_id)
    )
    await conn.execute("DELETE FROM room_calendars WHERE room_id = ?", (room_id,))
    await conn.commit()
    return True


def calendar_says(state: dict | None, calendar: RoomCalendar, now: datetime) -> bool | None:
    """Whether a calendar entity puts the room in use right now; None if it can't say.

    In use while a matching event is on, and from ``lead_min`` before the next
    matching one starts. Home Assistant shows one event per calendar entity:
    the one under way, else the next to come.
    """
    value = (state or {}).get("state")
    if value not in ("on", "off"):
        return None
    attrs = (state or {}).get("attributes") or {}
    wanted = calendar.match_text.casefold()
    if wanted and wanted not in str(attrs.get("message") or "").casefold():
        # The event shown is some other event. Nothing says a matching one is near.
        return False
    if value == "on":
        return True
    try:
        # Calendar attributes are wall-clock times in Home Assistant's own zone.
        start = datetime.strptime(str(attrs.get("start_time")), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return False
    start = start.replace(tzinfo=tz.get_timezone())
    return timedelta(0) <= start - now <= timedelta(minutes=calendar.lead_min)


async def refresh_calendars(
    conn: aiosqlite.Connection, get_state: Any, now: datetime, *, connected: bool = True
) -> list[tuple[str, bool]]:
    """Re-read every followed calendar; returns (room_id, in_use) for each change.

    A calendar that can't be read, or any calendar while Home Assistant is
    disconnected, changes nothing: the room keeps what the calendar last said.
    """
    if not connected:
        return []
    changed: list[tuple[str, bool]] = []
    for room_id, calendar in (await load(conn)).calendars.items():
        says = calendar_says(get_state(calendar.entity_id), calendar, now)
        if says is None or says == calendar.in_use:
            continue
        await conn.execute(
            "UPDATE room_calendars SET in_use = ? WHERE room_id = ?", (int(says), room_id)
        )
        changed.append((room_id, says))
    if changed:
        await conn.commit()
    return changed
