"""Door and window pausing (HomeClimate Smart Control).

A *contact sensor* (a ``binary_sensor`` door or window) is attached either to a
whole zone or to one room. When it stays open long enough the zone's thermostat
or the room stops calling for air, and it resumes once everything it watches
has been closed for the resume delay.

Rules, in the owner's words:

* Only a closed → open change starts the timer. A sensor that reports open
  after being offline, or that is already open when HomeClimate starts, does
  not pause anything until it closes and opens again.
* A sensor that goes offline releases its pause, exactly as if it had closed.

Settings are house-wide (``system_settings`` keys ``openings_<name>``) with
optional per-zone and per-room overrides in ``smart_control_overrides``.
The monitor keeps its timers in memory; the engine asks it each tick which
zone or rooms are paused.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import aiosqlite

from . import db
from .user_errors import UserError, fixed

SETTING_PREFIX = "openings_"

# name -> (kind, default, minimum, maximum)
SETTINGS: dict[str, tuple[str, Any, int, int]] = {
    "zone_pause_enabled": ("bool", True, 0, 1),
    "zone_pause_min": ("int", 3, 1, 60),
    "room_pause_enabled": ("bool", True, 0, 1),
    "room_pause_min": ("int", 5, 1, 60),
    "resume_min": ("int", 2, 0, 30),
}

OVERRIDE_KEYS: dict[str, tuple[str, ...]] = {
    "zone": ("zone_pause_enabled", "zone_pause_min", "resume_min"),
    "room": ("room_pause_enabled", "room_pause_min", "resume_min"),
}

OPEN, CLOSED, OFFLINE = "open", "closed", "offline"


class OpeningsError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


UNKNOWN_SETTING = fixed("Unknown Smart Control setting")
_BOOL_MESSAGES = {
    n: fixed(f"{n} must be true or false") for n, v in SETTINGS.items() if v[0] == "bool"
}
_INT_MESSAGES = {
    n: fixed(f"{n} must be a whole number of minutes from {v[2]} to {v[3]}")
    for n, v in SETTINGS.items()
    if v[0] == "int"
}
BAD_SCOPE = fixed("Scope must be zone or room")
_NOT_OVERRIDABLE = {
    scope: fixed(f"Only {', '.join(keys)} can be overridden for a {scope}")
    for scope, keys in OVERRIDE_KEYS.items()
}
NOT_A_CONTACT = fixed("Choose a door or window binary_sensor")
NEEDS_ONE_TARGET = fixed("Attach the sensor to a zone or to one room")
ZONE_UNKNOWN = fixed("That zone does not exist")
ROOM_UNKNOWN = fixed("That room does not exist")


def classify(state: dict | None) -> str:
    value = (state or {}).get("state")
    if value == "on":
        return OPEN
    if value == "off":
        return CLOSED
    return OFFLINE


def parse_value(name: str, value: Any) -> Any:
    """Validate one setting value from an API body and return it typed."""
    if name not in SETTINGS:
        raise OpeningsError(UNKNOWN_SETTING)
    kind, _default, lo, hi = SETTINGS[name]
    if kind == "bool":
        if not isinstance(value, bool):
            raise OpeningsError(_BOOL_MESSAGES[name])
        return value
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or value != int(value)
        or not lo <= int(value) <= hi
    ):
        raise OpeningsError(_INT_MESSAGES[name])
    return int(value)


def _decode(name: str, raw: str) -> Any:
    kind, default, lo, hi = SETTINGS[name]
    if kind == "bool":
        return raw == "1" if raw in ("0", "1") else default
    try:
        number = int(raw)
    except ValueError:
        return default
    return number if lo <= number <= hi else default


def _encode(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(int(value))


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


async def _zone_exists(conn: aiosqlite.Connection, entity_id: str) -> bool:
    async with conn.execute(
        "SELECT 1 FROM thermostat_configs WHERE thermostat_entity_id=?", (entity_id,)
    ) as cur:
        return await cur.fetchone() is not None


async def get_settings(conn: aiosqlite.Connection) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, (_kind, default, _lo, _hi) in SETTINGS.items():
        raw = await db.get_system_setting(conn, SETTING_PREFIX + name, "")
        out[name] = _decode(name, raw) if raw else default
    return out


async def update_settings(conn: aiosqlite.Connection, body: dict[str, Any]) -> dict[str, Any]:
    parsed = {name: parse_value(name, value) for name, value in body.items()}
    for name, value in parsed.items():
        await db.set_system_setting(conn, SETTING_PREFIX + name, _encode(value))
    return await get_settings(conn)


async def list_overrides(conn: aiosqlite.Connection) -> list[dict[str, Any]]:
    async with conn.execute(
        "SELECT scope, scope_id, key, value FROM smart_control_overrides "
        "ORDER BY scope, scope_id, key"
    ) as cur:
        rows = await cur.fetchall()
    return [
        {
            "scope": r["scope"],
            "scope_id": r["scope_id"],
            "key": r["key"],
            "value": _decode(r["key"], r["value"]),
        }
        for r in rows
        if r["key"] in SETTINGS
    ]


async def set_overrides(
    conn: aiosqlite.Connection, scope: str, scope_id: str, body: dict[str, Any]
) -> None:
    """Set (or, with ``None``, clear) override keys for one zone or room."""
    if scope not in OVERRIDE_KEYS:
        raise OpeningsError(BAD_SCOPE)
    allowed = OVERRIDE_KEYS[scope]
    exists = (
        await _zone_exists(conn, scope_id)
        if scope == "zone"
        else await db.get_room(conn, scope_id) is not None
    )
    if not exists:
        raise LookupError(scope)
    writes: list[tuple[str, str | None]] = []
    for key, value in body.items():
        if key not in allowed:
            raise OpeningsError(_NOT_OVERRIDABLE[scope])
        writes.append((key, None if value is None else _encode(parse_value(key, value))))
    for key, encoded in writes:
        if encoded is None:
            await conn.execute(
                "DELETE FROM smart_control_overrides WHERE scope=? AND scope_id=? AND key=?",
                (scope, scope_id, key),
            )
        else:
            await conn.execute(
                """INSERT INTO smart_control_overrides(scope, scope_id, key, value)
                   VALUES(?,?,?,?)
                   ON CONFLICT(scope, scope_id, key) DO UPDATE SET value=excluded.value""",
                (scope, scope_id, key, encoded),
            )
    await conn.commit()


@dataclass
class ContactSensor:
    entity_id: str
    thermostat_entity_id: str | None = None
    room_id: str | None = None


async def list_contacts(conn: aiosqlite.Connection) -> list[ContactSensor]:
    async with conn.execute(
        "SELECT entity_id, thermostat_entity_id, room_id FROM contact_sensors ORDER BY entity_id"
    ) as cur:
        rows = await cur.fetchall()
    return [ContactSensor(r["entity_id"], r["thermostat_entity_id"], r["room_id"]) for r in rows]


async def save_contact(
    conn: aiosqlite.Connection,
    entity_id: str,
    thermostat_entity_id: str | None,
    room_id: str | None,
) -> ContactSensor:
    """Attach a sensor to a zone or a room, or move it if already attached."""
    if not isinstance(entity_id, str) or not entity_id.startswith("binary_sensor."):
        raise OpeningsError(NOT_A_CONTACT)
    if (thermostat_entity_id is None) == (room_id is None):
        raise OpeningsError(NEEDS_ONE_TARGET)
    if thermostat_entity_id is not None:
        if not isinstance(thermostat_entity_id, str) or not await _zone_exists(
            conn, thermostat_entity_id
        ):
            raise OpeningsError(ZONE_UNKNOWN)
    elif not isinstance(room_id, str) or await db.get_room(conn, room_id) is None:
        raise OpeningsError(ROOM_UNKNOWN)
    await conn.execute(
        """INSERT INTO contact_sensors(entity_id, thermostat_entity_id, room_id)
           VALUES(?,?,?)
           ON CONFLICT(entity_id) DO UPDATE SET
               thermostat_entity_id=excluded.thermostat_entity_id,
               room_id=excluded.room_id""",
        (entity_id, thermostat_entity_id, room_id),
    )
    await conn.commit()
    return ContactSensor(entity_id, thermostat_entity_id, room_id)


async def delete_contact(conn: aiosqlite.Connection, entity_id: str) -> bool:
    cur = await conn.execute("DELETE FROM contact_sensors WHERE entity_id=?", (entity_id,))
    await conn.commit()
    return (cur.rowcount or 0) > 0


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


@dataclass
class ScopeSettings:
    enabled: bool
    delay_min: int
    resume_min: int


def resolve_settings(
    settings: dict[str, Any],
    overrides: list[dict[str, Any]],
    scope: str,
    scope_id: str,
    zone_id: str | None = None,
) -> ScopeSettings:
    """Effective settings for one zone or room.

    A room uses its own override, then the house-wide value. Its resume delay
    falls back to its zone's override before the house-wide value.
    """
    own = {
        o["key"]: o["value"] for o in overrides if (o["scope"], o["scope_id"]) == (scope, scope_id)
    }
    zone = (
        {
            o["key"]: o["value"]
            for o in overrides
            if (o["scope"], o["scope_id"]) == ("zone", zone_id)
        }
        if scope == "room" and zone_id
        else {}
    )
    prefix = f"{scope}_pause_"
    return ScopeSettings(
        enabled=own.get(prefix + "enabled", settings[prefix + "enabled"]),
        delay_min=own.get(prefix + "min", settings[prefix + "min"]),
        resume_min=own.get("resume_min", zone.get("resume_min", settings["resume_min"])),
    )


@dataclass
class Transition:
    scope: str
    scope_id: str
    name: str
    paused: bool
    sensors: list[str] = field(default_factory=list)


@dataclass
class _Watched:
    entity_id: str
    scope: str
    scope_id: str
    zone_id: str


class OpeningMonitor:
    """In-memory door/window timers and the pause state they produce."""

    def __init__(self) -> None:
        self._last: dict[str, str] = {}
        self._opened_at: dict[str, datetime] = {}
        self._paused_since: dict[tuple[str, str], datetime] = {}
        self._clear_since: dict[tuple[str, str], datetime] = {}
        self._watched: dict[str, _Watched] = {}
        self._room_zone: dict[str, str] = {}

    @property
    def entities(self) -> frozenset[str]:
        return frozenset(self._watched)

    def observe(self, entity_id: str, state: dict | None, now: datetime) -> None:
        kind = classify(state)
        previous = self._last.get(entity_id)
        self._last[entity_id] = kind
        if kind == OPEN:
            if previous == CLOSED:
                self._opened_at[entity_id] = now
        else:
            self._opened_at.pop(entity_id, None)

    def state_of(self, entity_id: str) -> str | None:
        return self._last.get(entity_id)

    def open_since(self, entity_id: str) -> datetime | None:
        return self._opened_at.get(entity_id)

    def paused_since(self, scope: str, scope_id: str) -> datetime | None:
        return self._paused_since.get((scope, scope_id))

    def paused_items(self) -> list[tuple[tuple[str, str], datetime]]:
        return sorted(self._paused_since.items())

    def pause_for(self, thermostat_entity_id: str) -> tuple[bool, frozenset[str]]:
        """``(zone paused, paused room ids)`` for one thermostat."""
        zone = ("zone", thermostat_entity_id) in self._paused_since
        rooms = frozenset(
            sid
            for (scope, sid) in self._paused_since
            if scope == "room" and self._room_zone.get(sid) == thermostat_entity_id
        )
        return zone, rooms

    async def evaluate(
        self,
        conn: aiosqlite.Connection,
        get_state: Callable[[str], dict | None],
        now: datetime,
    ) -> list[Transition]:
        """Refresh the watched set from the DB and return pause changes."""
        settings = await get_settings(conn)
        overrides = await list_overrides(conn)
        rooms = {r.id: r for r in await db.get_all_rooms(conn)}
        self._room_zone = {rid: r.thermostat_entity_id for rid, r in rooms.items()}
        zone_names = {
            tc.thermostat_entity_id: tc.name for tc in await db.get_all_thermostat_configs(conn)
        }

        watched: dict[str, _Watched] = {}
        for c in await list_contacts(conn):
            if c.room_id is not None:
                room = rooms.get(c.room_id)
                if room is None:  # pragma: no cover - the FK cascade removes these
                    continue
                watched[c.entity_id] = _Watched(
                    c.entity_id, "room", c.room_id, room.thermostat_entity_id
                )
            else:
                tid = str(c.thermostat_entity_id)
                watched[c.entity_id] = _Watched(c.entity_id, "zone", tid, tid)
        self._watched = watched
        for eid in watched:
            state = get_state(eid)
            if eid not in self._last and state is not None:
                # First sight: remember the state but start no timer. Nothing is
                # recorded while Home Assistant's states have not loaded yet, so
                # the first real reading is not mistaken for "offline".
                self._last[eid] = classify(state)

        scopes: dict[tuple[str, str], list[_Watched]] = {}
        for w in watched.values():
            scopes.setdefault((w.scope, w.scope_id), []).append(w)

        transitions: list[Transition] = []
        for key in sorted(set(scopes) | set(self._paused_since)):
            scope, scope_id = key
            members = scopes.get(key, [])
            zone_id = members[0].zone_id if members else self._room_zone.get(scope_id, scope_id)
            eff = resolve_settings(settings, overrides, scope, scope_id, zone_id)
            name = (
                (rooms[scope_id].name if scope_id in rooms else scope_id)
                if scope == "room"
                else (zone_names.get(scope_id) or scope_id)
            )
            open_members = [m.entity_id for m in members if m.entity_id in self._opened_at]
            triggering = [
                eid
                for eid in open_members
                if (now - self._opened_at[eid]).total_seconds() >= eff.delay_min * 60
            ]
            paused = key in self._paused_since
            if eff.enabled and triggering:
                self._clear_since.pop(key, None)
                if not paused:
                    self._paused_since[key] = now
                    transitions.append(Transition(scope, scope_id, name, True, triggering))
                continue
            if not paused:
                continue
            if eff.enabled and open_members:
                # Still open, just not long enough to (re)trigger: stay paused.
                self._clear_since.pop(key, None)
                continue
            since = self._clear_since.setdefault(key, now)
            if not eff.enabled or (now - since).total_seconds() >= eff.resume_min * 60:
                del self._paused_since[key]
                self._clear_since.pop(key, None)
                transitions.append(Transition(scope, scope_id, name, False))
        return transitions
