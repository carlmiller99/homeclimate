"""Smart Learning: the always-on room sampler.

A learned model of a room needs to see it idle as well as running, and cycle
logs only cover running cycles. So every few minutes, whatever the system is
doing, one row per room records its temperature and what surrounded it: the
thermostat's reading, outdoors, what the equipment was doing, how open the
vents were, and whether the room was occupied or had a door or window open.

Sampling only reads Home Assistant state. It commands nothing.
"""

from __future__ import annotations

import math
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
    opening: bool | None
    # A fireplace that warms this room is lit or cooling down; None with no fireplace.
    fireplace: bool | None = None


def _mean(values: Iterable[float | None], digits: int) -> float | None:
    """Mean of the known, finite values; None when there are none."""
    found = [v for v in values if v is not None and math.isfinite(v)]
    return round(sum(found) / len(found), digits) if found else None


def slot(now: datetime) -> datetime:
    """``now`` moved back to the start of its sampling slot, so readings sit on a grid."""
    return now.replace(minute=now.minute - now.minute % SAMPLE_EVERY_MIN, second=0, microsecond=0)


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
    vent_openness: Callable[[RoomVent], float | None],
    aux_running: Callable[[str], bool],
    contact_states: dict[str, list[str]],
    fireplace_rooms: dict[str, bool] | None = None,
) -> list[RoomSample]:
    """Read one sample for every room from Home Assistant's current state.

    ``contact_states`` maps a room id to the open/closed/offline state of each
    of its door and window sensors.
    """
    rooms: list[Room] = await db.get_all_rooms(conn)
    outside_id = await db.get_system_setting(conn, "outside_temperature_entity_id", "")
    outside = ha.get_numeric_state(outside_id) if outside_id else None

    room_vents: dict[str, list[float | None]] = {}
    zone_vents: dict[str, list[float | None]] = {}
    for room in rooms:
        found = [vent_openness(v) for v in await db.get_room_vents(conn, room.id)]
        room_vents[room.id] = found
        zone_vents.setdefault(room.thermostat_entity_id, []).extend(found)

    samples = []
    for room in rooms:
        sensors = await db.get_room_sensors(conn, room.id)
        presence = await db.get_room_presence_sensors(conn, room.id)
        thermo = ha.get_state(room.thermostat_entity_id) or {}
        attrs = thermo.get("attributes") or {}
        zone_temp = _as_f(attrs.get("current_temperature"), ha.ha_temp_unit)
        readings = [ha.get_numeric_state(s.entity_id, max_age_min=stale_after_min) for s in sensors]
        if room.include_thermostat_sensor:
            # The engine counts the thermostat's own probe for this room too.
            readings.append(zone_temp)
        contacts = contact_states.get(room.id, [])
        samples.append(
            RoomSample(
                ts=slot(now),
                room_id=room.id,
                thermostat_entity_id=room.thermostat_entity_id,
                room_temp=_mean(readings, 2),
                zone_temp=zone_temp,
                outside_temp=_mean([outside], 2),
                hvac_action=str(attrs.get("hvac_action") or "unknown"),
                aux_heat=aux_running(room.thermostat_entity_id),
                vent_open=_mean(room_vents[room.id], 3),
                zone_vent_open=_mean(zone_vents[room.thermostat_entity_id], 3),
                occupied=_occupied([ha.get_state(p.entity_id) for p in presence]),
                opening=_opening(contacts),
                fireplace=(fireplace_rooms or {}).get(room.id),
            )
        )
    return samples


def _opening(contacts: list[str]) -> bool | None:
    """Open if any contact is; closed only if every one reports closed; else unknown."""
    if "open" in contacts:
        return True
    return False if contacts and all(c == "closed" for c in contacts) else None


def _as_f(value: Any, unit: str) -> float | None:
    """A climate entity's temperature (in HA's unit) as °F, or None."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return to_f(float(value), unit)


def _flag(value: bool | None) -> int | None:
    return None if value is None else int(value)


def _scaled(value: float | None, scale: int) -> int | None:
    return None if value is None else round(value * scale)


def _unscaled(value: int | None, scale: int) -> float | None:
    return None if value is None else value / scale


# Stored integer = value × scale: temperatures to 0.01 °F, vent openness to 0.001.
TEMP_SCALE = 100
VENT_SCALE = 1000


async def _key(
    conn: aiosqlite.Connection, cache: dict[tuple[str, str], int], kind: str, value: str
) -> int:
    """The number standing for ``value``, allotting one the first time it is seen."""
    if (kind, value) not in cache:
        await conn.execute(
            "INSERT OR IGNORE INTO room_reading_keys(kind, value) VALUES(?, ?)", (kind, value)
        )
        async with conn.execute(
            "SELECT key FROM room_reading_keys WHERE kind = ? AND value = ?", (kind, value)
        ) as cur:
            row = await cur.fetchone()
        assert row is not None  # inserted just above
        cache[(kind, value)] = row["key"]
    return cache[(kind, value)]


async def store(conn: aiosqlite.Connection, samples: list[RoomSample]) -> None:
    cache: dict[tuple[str, str], int] = {}
    rows = [
        (
            await _key(conn, cache, "room", s.room_id),
            int(s.ts.timestamp()),
            await _key(conn, cache, "zone", s.thermostat_entity_id),
            await _key(conn, cache, "action", s.hvac_action),
            _scaled(s.room_temp, TEMP_SCALE),
            _scaled(s.zone_temp, TEMP_SCALE),
            _scaled(s.outside_temp, TEMP_SCALE),
            int(s.aux_heat),
            _scaled(s.vent_open, VENT_SCALE),
            _scaled(s.zone_vent_open, VENT_SCALE),
            _flag(s.occupied),
            _flag(s.opening),
            _flag(s.fireplace),
        )
        for s in samples
    ]
    await conn.executemany(
        """INSERT OR REPLACE INTO room_readings(room_key, ts, zone_key, action_key, room_temp,
               zone_temp, outside_temp, aux_heat, vent_open, zone_vent_open, occupied, opening,
               fireplace)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    await conn.commit()


async def load(
    conn: aiosqlite.Connection, *, room_id: str | None = None, since: datetime | None = None
) -> list[RoomSample]:
    """Stored readings, oldest first within each room; optionally one room, or recent only."""
    async with conn.execute("SELECT key, kind, value FROM room_reading_keys") as cur:
        names = {r["key"]: r["value"] for r in await cur.fetchall()}
    async with conn.execute(
        "SELECT key FROM room_reading_keys WHERE kind = 'room' AND (?1 IS NULL OR value = ?1)",
        (room_id,),
    ) as cur:
        room_keys = [r["key"] for r in await cur.fetchall()]
    out: list[RoomSample] = []
    for key in sorted(room_keys):
        # One primary-key range per room.
        async with conn.execute(
            "SELECT * FROM room_readings WHERE room_key = ? AND ts >= ? ORDER BY ts",
            (key, int(since.timestamp()) if since else 0),
        ) as cur:
            rows = await cur.fetchall()
        out.extend(
            RoomSample(
                ts=datetime.fromtimestamp(r["ts"], UTC),
                room_id=names[r["room_key"]],
                thermostat_entity_id=names[r["zone_key"]],
                room_temp=_unscaled(r["room_temp"], TEMP_SCALE),
                zone_temp=_unscaled(r["zone_temp"], TEMP_SCALE),
                outside_temp=_unscaled(r["outside_temp"], TEMP_SCALE),
                hvac_action=names[r["action_key"]],
                aux_heat=bool(r["aux_heat"]),
                vent_open=_unscaled(r["vent_open"], VENT_SCALE),
                zone_vent_open=_unscaled(r["zone_vent_open"], VENT_SCALE),
                occupied=None if r["occupied"] is None else bool(r["occupied"]),
                opening=None if r["opening"] is None else bool(r["opening"]),
                fireplace=None if r["fireplace"] is None else bool(r["fireplace"]),
            )
            for r in rows
        )
    return out


async def adopt_first_build(conn: aiosqlite.Connection) -> int:
    """Move readings from the first recorder build's ``room_samples`` table, then drop it."""
    async with conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'room_samples'") as cur:
        if await cur.fetchone() is None:
            return 0
    async with conn.execute("SELECT * FROM room_samples ORDER BY id") as cur:
        old = list(await cur.fetchall())
    await store(
        conn,
        [
            RoomSample(
                ts=slot(datetime.fromisoformat(r["ts"])),
                room_id=r["room_id"],
                thermostat_entity_id=r["thermostat_entity_id"],
                room_temp=_mean([r["room_temp"]], 2),
                zone_temp=_mean([r["zone_temp"]], 2),
                outside_temp=_mean([r["outside_temp"]], 2),
                hvac_action=r["hvac_action"],
                aux_heat=bool(r["aux_heat"]),
                # That build counted an offline vent as closed and an offline
                # door as shut, so those two are kept only where they say "open".
                vent_open=_mean([r["vent_open"] or None], 3),
                zone_vent_open=_mean([r["zone_vent_open"] or None], 3),
                occupied=None if r["occupied"] is None else bool(r["occupied"]),
                opening=True if r["opening"] else None,
            )
            for r in old
        ],
    )
    await conn.execute("DROP TABLE room_samples")
    await conn.commit()
    return len(old)


async def purge(conn: aiosqlite.Connection, *, now: datetime, keep_days: int) -> int:
    """Delete readings older than ``keep_days``; returns how many went."""
    cutoff = int((now - timedelta(days=keep_days)).timestamp())
    # Room by room, so each delete is a range on the primary key, not a scan.
    cur = await conn.execute(
        """DELETE FROM room_readings WHERE ts < ?1 AND room_key IN
               (SELECT key FROM room_reading_keys WHERE kind = 'room')""",
        (cutoff,),
    )
    await conn.commit()
    return cur.rowcount


def _iso(ts: int | None) -> str | None:
    return None if ts is None else datetime.fromtimestamp(ts, UTC).isoformat()


async def status(conn: aiosqlite.Connection, *, now: datetime) -> dict[str, Any]:
    """How much has been collected, overall and per room."""
    async with conn.execute(
        """SELECT k.value AS room_id, COUNT(*) AS n, MIN(r.ts) AS first, MAX(r.ts) AS last,
                  SUM(r.room_temp IS NOT NULL) AS with_temp
           FROM room_readings r JOIN room_reading_keys k ON k.key = r.room_key
           GROUP BY r.room_key"""
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
                "first_sample_at": _iso(row["first"]) if row else None,
                "last_sample_at": _iso(row["last"]) if row else None,
            }
        )
    return {
        # Totals cover every stored reading, including rooms since deleted.
        "samples": sum(r["n"] for r in rows.values()),
        "collecting_since": _iso(min((r["first"] for r in rows.values()), default=None)),
        "last_sample_at": _iso(max((r["last"] for r in rows.values()), default=None)),
        "sample_every_min": SAMPLE_EVERY_MIN,
        "checked_at": now.astimezone(UTC).isoformat(),
        "rooms": rooms,
    }
