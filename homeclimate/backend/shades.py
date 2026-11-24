"""Shades (HomeClimate Smart Control).

A shade is a ``cover`` that is not a vent. Each belongs to one room and knows
which way its window faces. When automation is on, a sunlit shade opens while
its zone heats (free heat) and closes while it cools (blocks the heat). A
shade is never moved:

* when it is marked Never Control;
* while the room is occupied (if that setting is on);
* during quiet hours, for shades marked for them;
* for a while after someone moves it by hand (if that setting is on);
* more often than the minimum time between moves.

A window counts as sunlit when the sun is more than a few degrees up, within
80° of the direction the window faces, and the sky is not overcast.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Any

import aiosqlite

from . import db
from .user_errors import UserError, fixed

FACINGS: dict[str, int] = {
    "N": 0,
    "NE": 45,
    "E": 90,
    "SE": 135,
    "S": 180,
    "SW": 225,
    "W": 270,
    "NW": 315,
}
SUN_MIN_ELEVATION = 5.0
SUN_MAX_ANGLE = 80.0
OVERCAST_PCT = 80.0
MANUAL_GRACE = timedelta(minutes=3)

SETTING_PREFIX = "shades_"
# name -> (kind, default, minimum, maximum)
SETTINGS: dict[str, tuple[str, Any, int, int]] = {
    "auto_enabled": ("bool", False, 0, 1),
    "skip_occupied": ("bool", True, 0, 1),
    "daylight_only": ("bool", True, 0, 1),
    "close_night_heat": ("bool", False, 0, 1),
    "respect_manual": ("bool", True, 0, 1),
    "manual_hold_min": ("int", 120, 15, 720),
    "min_move_min": ("int", 30, 5, 240),
    "quiet_hours": ("bool", False, 0, 1),
    "quiet_start": ("time", "20:00", 0, 0),
    "quiet_end": ("time", "07:00", 0, 0),
    "weather_entity": ("entity", "", 0, 0),
}

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class ShadeError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


UNKNOWN_SETTING = fixed("Unknown shade setting")
_SETTING_MESSAGES = {
    name: fixed(
        {
            "bool": f"{name} must be true or false",
            "int": f"{name} must be a whole number of minutes from {lo} to {hi}",
            "time": f"{name} must be a time like 20:00",
            "entity": f"{name} must be a weather entity or empty",
        }[kind]
    )
    for name, (kind, _d, lo, hi) in SETTINGS.items()
}
NOT_A_COVER = fixed("Choose a cover entity for the shade")
IS_A_VENT = fixed("That cover is already a vent")
ROOM_UNKNOWN = fixed("That room does not exist")
BAD_FACING = fixed("Window Faces must be one of N, NE, E, SE, S, SW, W, NW")
BAD_POSITION = fixed("Positions must be whole numbers from 0 to 100, or empty")
BAD_FLAG = fixed("never_control and quiet_hours must be true or false")


def parse_setting(name: str, value: Any) -> Any:
    if name not in SETTINGS:
        raise ShadeError(UNKNOWN_SETTING)
    kind, _default, lo, hi = SETTINGS[name]
    message = _SETTING_MESSAGES[name]
    if kind == "bool":
        if not isinstance(value, bool):
            raise ShadeError(message)
        return value
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
            raise ShadeError(message)
        return value
    if kind == "time":
        if not isinstance(value, str) or not _TIME_RE.match(value):
            raise ShadeError(message)
        return value
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or not value.startswith("weather."):
        raise ShadeError(message)
    return value


def _decode(name: str, raw: str) -> Any:
    kind, default, lo, hi = SETTINGS[name]
    if kind == "bool":
        return raw == "1" if raw in ("0", "1") else default
    if kind == "int":
        try:
            n = int(raw)
        except ValueError:
            return default
        return n if lo <= n <= hi else default
    if kind == "time":
        return raw if _TIME_RE.match(raw) else default
    return raw


def _encode(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value)


async def get_settings(conn: aiosqlite.Connection) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, (_kind, default, _lo, _hi) in SETTINGS.items():
        raw = await db.get_system_setting(conn, SETTING_PREFIX + name, "\x00")
        out[name] = default if raw == "\x00" else _decode(name, raw)
    return out


async def update_settings(conn: aiosqlite.Connection, body: dict[str, Any]) -> dict[str, Any]:
    parsed = {name: parse_setting(name, value) for name, value in body.items()}
    for name, value in parsed.items():
        await db.set_system_setting(conn, SETTING_PREFIX + name, _encode(value))
    return await get_settings(conn)


@dataclass
class Shade:
    entity_id: str
    room_id: str
    facing: str
    never_control: bool = False
    quiet_hours: bool = False
    open_position: int | None = None
    closed_position: int | None = None


async def list_shades(conn: aiosqlite.Connection) -> list[Shade]:
    async with conn.execute("SELECT * FROM room_shades ORDER BY entity_id") as cur:
        rows = await cur.fetchall()
    return [
        Shade(
            entity_id=r["entity_id"],
            room_id=r["room_id"],
            facing=r["facing"],
            never_control=bool(r["never_control"]),
            quiet_hours=bool(r["quiet_hours"]),
            open_position=r["open_position"],
            closed_position=r["closed_position"],
        )
        for r in rows
    ]


def _position(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
        raise ShadeError(BAD_POSITION)
    return value


async def save_shade(conn: aiosqlite.Connection, entity_id: str, body: dict[str, Any]) -> Shade:
    if not entity_id.startswith("cover."):
        raise ShadeError(NOT_A_COVER)
    async with conn.execute("SELECT 1 FROM room_vents WHERE entity_id=?", (entity_id,)) as cur:
        if await cur.fetchone():
            raise ShadeError(IS_A_VENT)
    current = {s.entity_id: s for s in await list_shades(conn)}.get(entity_id)
    room_id = body.get("room_id", current.room_id if current else None)
    if not isinstance(room_id, str) or await db.get_room(conn, room_id) is None:
        raise ShadeError(ROOM_UNKNOWN)
    facing = body.get("facing", current.facing if current else None)
    if facing not in FACINGS:
        raise ShadeError(BAD_FACING)
    flags = {}
    for name in ("never_control", "quiet_hours"):
        value = body.get(name, getattr(current, name) if current else False)
        if not isinstance(value, bool):
            raise ShadeError(BAD_FLAG)
        flags[name] = value
    shade = Shade(
        entity_id=entity_id,
        room_id=room_id,
        facing=str(facing),
        never_control=flags["never_control"],
        quiet_hours=flags["quiet_hours"],
        open_position=_position(
            body.get("open_position", current.open_position if current else None)
        ),
        closed_position=_position(
            body.get("closed_position", current.closed_position if current else None)
        ),
    )
    await conn.execute(
        """INSERT INTO room_shades(entity_id, room_id, facing, never_control, quiet_hours,
               open_position, closed_position) VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(entity_id) DO UPDATE SET room_id=excluded.room_id,
               facing=excluded.facing, never_control=excluded.never_control,
               quiet_hours=excluded.quiet_hours, open_position=excluded.open_position,
               closed_position=excluded.closed_position""",
        (
            shade.entity_id,
            shade.room_id,
            shade.facing,
            int(shade.never_control),
            int(shade.quiet_hours),
            shade.open_position,
            shade.closed_position,
        ),
    )
    await conn.commit()
    return shade


async def delete_shade(conn: aiosqlite.Connection, entity_id: str) -> bool:
    cur = await conn.execute("DELETE FROM room_shades WHERE entity_id=?", (entity_id,))
    await conn.commit()
    return (cur.rowcount or 0) > 0


# ---------------------------------------------------------------------------
# Decisions
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Sun:
    elevation: float | None
    azimuth: float | None
    cloud_pct: float | None = None

    @classmethod
    def read(cls, sun_state: dict | None, weather_state: dict | None) -> Sun:
        attrs = (sun_state or {}).get("attributes") or {}
        cloud = ((weather_state or {}).get("attributes") or {}).get("cloud_coverage")
        return cls(_num(attrs.get("elevation")), _num(attrs.get("azimuth")), _num(cloud))


def _num(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def angle_between(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def in_quiet_hours(now: time, start: str, end: str) -> bool:
    s = time.fromisoformat(start)
    e = time.fromisoformat(end)
    if s <= e:
        return s <= now < e
    return now >= s or now < e


OPEN, CLOSE = "open", "close"


def decide(
    shade: Shade,
    settings: dict[str, Any],
    sun: Sun,
    mode: str | None,
    *,
    occupied: bool,
    held: bool,
    local_time: time,
) -> tuple[str | None, str]:
    """What a shade should do now, and why, in words for the Logs and UI."""
    if shade.never_control:
        return None, "Never controlled."
    if not settings["auto_enabled"]:
        return None, "Automation is off."
    if held:
        return None, "Moved by hand, so automation waits."
    if (
        settings["quiet_hours"]
        and shade.quiet_hours
        and in_quiet_hours(local_time, settings["quiet_start"], settings["quiet_end"])
    ):
        return None, "Quiet hours, left alone."
    if settings["skip_occupied"] and occupied:
        return None, "Room occupied, left alone."
    if sun.elevation is None or sun.azimuth is None:
        return None, "Sun position unknown, left alone."
    if sun.elevation <= 0:
        if settings["close_night_heat"] and not settings["daylight_only"] and mode == "heating":
            return CLOSE, "Night and heating, so closed to hold in heat."
        return None, "Overnight, left alone."
    if mode not in ("heating", "cooling"):
        return None, "Zone is idle, left alone."
    if sun.cloud_pct is not None and sun.cloud_pct >= OVERCAST_PCT:
        return None, "Overcast, left alone."
    sunlit = (
        sun.elevation > SUN_MIN_ELEVATION
        and angle_between(sun.azimuth, FACINGS[shade.facing]) <= SUN_MAX_ANGLE
    )
    if not sunlit:
        return None, "Not sunlit, left alone."
    if mode == "heating":
        return OPEN, "Sunlit and heating, so opened."
    return CLOSE, "Sunlit and cooling, so closed."


def is_open(state: dict | None, shade: Shade | None = None) -> bool | None:
    """True/False for a settled shade, None while moving or unknown.

    With a position, the shade counts as open when it is nearer its open
    position (default 100) than its closed position (default 0), so custom
    positions such as "closed at 5 %" read correctly.
    """
    if not state:
        return None
    value = state.get("state")
    if value not in ("open", "closed"):
        return None
    position = (state.get("attributes") or {}).get("current_position")
    if isinstance(position, int | float) and not isinstance(position, bool):
        open_at = shade.open_position if shade and shade.open_position is not None else 100
        closed_at = shade.closed_position if shade and shade.closed_position is not None else 0
        return bool(abs(position - open_at) < abs(position - closed_at))
    return bool(value == "open")


@dataclass
class ShadeStatus:
    reason: str = ""
    last_moved_at: datetime | None = None
    hold_until: datetime | None = None


@dataclass
class ShadeMove:
    entity_id: str
    action: str
    reason: str


class ShadeController:
    """Runs the shade decisions each tick and remembers what it did."""

    def __init__(self) -> None:
        self.status: dict[str, ShadeStatus] = {}
        self._seen: dict[str, bool] = {}

    async def run(
        self,
        conn: aiosqlite.Connection,
        ha: Any,
        mode_for: Callable[[str], str | None],
        now: datetime,
        local_time: time,
    ) -> list[ShadeMove]:
        settings = await get_settings(conn)
        sun = Sun.read(
            ha.get_state("sun.sun"),
            ha.get_state(settings["weather_entity"]) if settings["weather_entity"] else None,
        )
        rooms = {r.id: r for r in await db.get_all_rooms(conn)}
        moves: list[ShadeMove] = []
        shades = await list_shades(conn)
        for gone in set(self.status) - {s.entity_id for s in shades}:
            del self.status[gone]
            self._seen.pop(gone, None)
        for shade in shades:
            status = self.status.setdefault(shade.entity_id, ShadeStatus())
            state = ha.get_state(shade.entity_id)
            now_open = is_open(state, shade)
            previous = self._seen.get(shade.entity_id)
            if now_open is not None:
                self._seen[shade.entity_id] = now_open
                moved_by_hand = (
                    previous is not None
                    and now_open != previous
                    and (status.last_moved_at is None or now - status.last_moved_at > MANUAL_GRACE)
                )
                if moved_by_hand and settings["respect_manual"]:
                    status.hold_until = now + timedelta(minutes=settings["manual_hold_min"])
            held = status.hold_until is not None and now < status.hold_until
            room = rooms[shade.room_id]  # the FK cascade removes shades with their room
            occupied = any(
                (ha.get_state(ps.entity_id) or {}).get("state") == "on"
                for ps in await db.get_room_presence_sensors(conn, room.id)
            )
            mode = mode_for(room.thermostat_entity_id)
            action, reason = decide(
                shade, settings, sun, mode, occupied=occupied, held=held, local_time=local_time
            )
            status.reason = reason
            if action is None or now_open is None or now_open == (action == OPEN):
                continue
            if status.last_moved_at is not None and now - status.last_moved_at < timedelta(
                minutes=settings["min_move_min"]
            ):
                continue
            await _command(ha, shade, action)
            status.last_moved_at = now
            self._seen[shade.entity_id] = action == OPEN
            moves.append(ShadeMove(shade.entity_id, action, reason))
        return moves


async def _command(ha: Any, shade: Shade, action: str) -> None:
    if action == OPEN:
        if shade.open_position is not None:
            await ha.set_cover_position(shade.entity_id, shade.open_position)
        else:
            await ha.open_cover(shade.entity_id)
    elif shade.closed_position is not None:
        await ha.set_cover_position(shade.entity_id, shade.closed_position)
    else:
        await ha.close_cover(shade.entity_id)
