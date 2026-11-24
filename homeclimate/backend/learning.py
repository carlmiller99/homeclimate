"""Smart Learning: the always-on room sampler.

A learned model of a room needs to see it idle as well as running, and cycle
logs only cover running cycles. So every few minutes, whatever the system is
doing, one row per room records its temperature and what surrounded it: the
thermostat's reading, outdoors, what the equipment was doing, how open the
vents were, and whether the room was occupied or had a door or window open.

Sampling only reads Home Assistant state. It commands nothing.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import db
from .models import Room, RoomVent
from .units import to_f
from .user_errors import UserError, fixed

SAMPLE_EVERY_MIN = 5

SETTING_PREFIX = "learning_"
# name -> (kind, default, minimum, maximum)
SETTINGS: dict[str, tuple[str, Any, int, int]] = {
    "sampling_enabled": ("bool", True, 0, 1),
    "sample_retention_days": ("int", 60, 30, 365),
}


class LearningError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


UNKNOWN_SETTING = fixed("Unknown learning setting")
_SETTING_MESSAGES = {
    "sampling_enabled": fixed("sampling_enabled must be true or false"),
    "sample_retention_days": fixed("sample_retention_days must be a whole number from 30 to 365"),
}


def parse_setting(name: str, value: Any) -> Any:
    if name not in SETTINGS:
        raise LearningError(UNKNOWN_SETTING)
    kind, _default, lo, hi = SETTINGS[name]
    if kind == "bool":
        if not isinstance(value, bool):
            raise LearningError(_SETTING_MESSAGES[name])
        return value
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise LearningError(_SETTING_MESSAGES[name])
    return value


def _decode(name: str, raw: str) -> Any:
    kind, default, lo, hi = SETTINGS[name]
    if kind == "bool":
        return raw == "1"
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if lo <= value <= hi else default


async def get_settings(conn: aiosqlite.Connection) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, (_kind, default, _lo, _hi) in SETTINGS.items():
        raw = await db.get_system_setting(conn, SETTING_PREFIX + name, "\x00")
        out[name] = default if raw == "\x00" else _decode(name, raw)
    return out


async def update_settings(conn: aiosqlite.Connection, body: dict[str, Any]) -> dict[str, Any]:
    parsed = {name: parse_setting(name, value) for name, value in body.items()}
    for name, value in parsed.items():
        encoded = ("1" if value else "0") if isinstance(value, bool) else str(value)
        await db.set_system_setting(conn, SETTING_PREFIX + name, encoded)
    return await get_settings(conn)


@dataclass(frozen=True)
class RoomSample:
    """One room at one moment. Temperatures are °F."""

    ts: datetime
    room_id: str
    thermostat_entity_id: str
    room_temp: float | None
    zone_temp: float | None
    outside_temp: float | None
    hvac_action: str
    aux_heat: bool
    vent_open: float | None
    zone_vent_open: float | None
    occupied: bool | None
    opening: bool


def _fraction(flags: list[bool]) -> float | None:
    """Share of vents open, or None with no vents."""
    return round(sum(flags) / len(flags), 3) if flags else None


def _mean(values: Iterable[float | None]) -> float | None:
    found = [v for v in values if v is not None]
    return round(sum(found) / len(found), 2) if found else None


def _occupied(states: list[dict | None]) -> bool | None:
    """True/False from presence sensors that are reporting; None when none is."""
    seen = [s.get("state") for s in states if s and s.get("state") in ("on", "off")]
    return ("on" in seen) if seen else None


async def collect(
    conn: aiosqlite.Connection,
    ha: Any,
    *,
    now: datetime,
    stale_after_min: float,
    vent_is_open: Callable[[RoomVent], bool],
    aux_running: Callable[[str], bool],
    open_contact_rooms: frozenset[str],
) -> list[RoomSample]:
    """Read one sample for every room from Home Assistant's current state."""
    rooms: list[Room] = await db.get_all_rooms(conn)
    outside_id = await db.get_system_setting(conn, "outside_temperature_entity_id", "")
    outside = ha.get_numeric_state(outside_id) if outside_id else None

    vents_by_room = {r.id: await db.get_room_vents(conn, r.id) for r in rooms}
    zone_flags: dict[str, list[bool]] = {}
    room_flags: dict[str, list[bool]] = {}
    for room in rooms:
        flags = [vent_is_open(v) for v in vents_by_room[room.id]]
        room_flags[room.id] = flags
        zone_flags.setdefault(room.thermostat_entity_id, []).extend(flags)

    samples = []
    for room in rooms:
        sensors = await db.get_room_sensors(conn, room.id)
        presence = await db.get_room_presence_sensors(conn, room.id)
        thermo = ha.get_state(room.thermostat_entity_id) or {}
        attrs = thermo.get("attributes") or {}
        zone_temp = attrs.get("current_temperature")
        samples.append(
            RoomSample(
                ts=now,
                room_id=room.id,
                thermostat_entity_id=room.thermostat_entity_id,
                room_temp=_mean(
                    ha.get_numeric_state(s.entity_id, max_age_min=stale_after_min) for s in sensors
                ),
                zone_temp=_as_f(zone_temp, ha.ha_temp_unit),
                outside_temp=outside,
                hvac_action=str(attrs.get("hvac_action") or "unknown"),
                aux_heat=aux_running(room.thermostat_entity_id),
                vent_open=_fraction(room_flags[room.id]),
                zone_vent_open=_fraction(zone_flags[room.thermostat_entity_id]),
                occupied=_occupied([ha.get_state(p.entity_id) for p in presence]),
                opening=room.id in open_contact_rooms,
            )
        )
    return samples


def _as_f(value: Any, unit: str) -> float | None:
    """A climate entity's temperature (in HA's unit) as °F, or None."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return to_f(float(value), unit)


def _flag(value: bool | None) -> int | None:
    return None if value is None else int(value)


async def store(conn: aiosqlite.Connection, samples: list[RoomSample]) -> None:
    await conn.executemany(
        """INSERT INTO room_samples(ts, room_id, thermostat_entity_id, room_temp, zone_temp,
               outside_temp, hvac_action, aux_heat, vent_open, zone_vent_open, occupied, opening)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
        [
            (
                s.ts.isoformat(),
                s.room_id,
                s.thermostat_entity_id,
                s.room_temp,
                s.zone_temp,
                s.outside_temp,
                s.hvac_action,
                int(s.aux_heat),
                s.vent_open,
                s.zone_vent_open,
                _flag(s.occupied),
                int(s.opening),
            )
            for s in samples
        ],
    )
    await conn.commit()


async def purge(conn: aiosqlite.Connection, *, now: datetime, keep_days: int) -> int:
    """Delete samples older than ``keep_days``; returns how many went."""
    cutoff = (now - timedelta(days=keep_days)).isoformat()
    cur = await conn.execute("DELETE FROM room_samples WHERE ts < ?", (cutoff,))
    await conn.commit()
    return cur.rowcount


async def status(conn: aiosqlite.Connection, *, now: datetime) -> dict[str, Any]:
    """How much has been collected, overall and per room."""
    async with conn.execute("SELECT COUNT(*) AS n, MIN(ts) AS first FROM room_samples") as cur:
        total = await cur.fetchone()
    assert total is not None  # an aggregate without GROUP BY always returns a row
    async with conn.execute(
        """SELECT room_id, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last,
                  SUM(room_temp IS NOT NULL) AS with_temp
           FROM room_samples GROUP BY room_id"""
    ) as cur:
        rows = {r["room_id"]: r for r in await cur.fetchall()}
    per_day = 24 * 60 / SAMPLE_EVERY_MIN
    rooms = []
    for room in await db.get_all_rooms(conn):
        row = rows.get(room.id)
        n = row["n"] if row else 0
        rooms.append(
            {
                "room_id": room.id,
                "name": room.name,
                "thermostat_entity_id": room.thermostat_entity_id,
                "samples": n,
                "days": round(n / per_day, 1),
                "with_temperature_pct": round(100 * row["with_temp"] / n) if row else 0,
                "first_sample_at": row["first"] if row else None,
                "last_sample_at": row["last"] if row else None,
            }
        )
    return {
        "samples": total["n"],
        "collecting_since": total["first"],
        "sample_every_min": SAMPLE_EVERY_MIN,
        "checked_at": now.astimezone(UTC).isoformat(),
        "rooms": rooms,
    }
