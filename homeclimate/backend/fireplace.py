"""Fireplaces: know when one is lit, and keep the rooms it warms out of the HVAC's way.

HomeClimate never commands a fireplace. It watches one Home Assistant entity
per fireplace (a relay, a switch, a binary sensor, a thermostat) to know when
the fire is lit. While it is lit, and for a cool-down afterwards, the rooms it
warms can be set aside: they stop calling for heating or cooling, so the heat
of the fire can neither satisfy nor confuse the system. Per-room safety limits
still apply to a room that is set aside.

Each fireplace has a control level:

- ``off``: ignored.
- ``watch``: tracked, shown and logged, but nothing changes.
- ``on``: its rooms are set aside while it is lit or cooling down.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import db
from .user_errors import UserError, fixed

CONTROLS = ("off", "watch", "on")
# Entity kinds that can say "the fire is lit".
SIGNAL_DOMAINS = ("switch", "binary_sensor", "input_boolean", "light", "fan", "climate")
COOLDOWN_MIN, COOLDOWN_MAX, COOLDOWN_DEFAULT = 0, 240, 60
NAME_MAX = 60

LIT, COOLING, OUT, UNKNOWN = "lit", "cooling", "out", "unknown"


class FireplaceError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


BAD_NAME = fixed("Give the fireplace a name of up to 60 characters")
NAME_TAKEN = fixed("Another fireplace already has that name")
BAD_ENTITY = fixed(
    "Choose a switch, binary_sensor, input_boolean, light, fan or climate entity"
    " that is on while the fire is lit"
)
BAD_ROOMS = fixed("Choose at least one room the fireplace warms")
ROOM_UNKNOWN = fixed("One of those rooms does not exist")
BAD_COOLDOWN = fixed("Cool-down must be a whole number of minutes from 0 to 240")
BAD_CONTROL = fixed("control must be off, watch or on")
UNKNOWN_FIELD = fixed("Unknown fireplace field")
NAME_AND_ENTITY_NEEDED = fixed("A fireplace needs a name, an entity and at least one room")


def is_lit(state: dict | None) -> bool | None:
    """Whether an entity says the fire is lit; None when it can't say.

    A thermostat-style entity is lit while it reports it is heating, not merely
    while it is switched to heat.
    """
    value = (state or {}).get("state")
    if value in (None, "unavailable", "unknown"):
        return None
    action = ((state or {}).get("attributes") or {}).get("hvac_action")
    if action is not None:
        return bool(action == "heating")
    return value in ("on", "heat")


@dataclass(frozen=True)
class Fireplace:
    id: str
    name: str
    entity_id: str
    cooldown_min: int
    control: str
    room_ids: tuple[str, ...]
    last_lit_at: datetime | None


async def list_fireplaces(conn: aiosqlite.Connection) -> list[Fireplace]:
    async with conn.execute(
        "SELECT fireplace_id, room_id FROM fireplace_rooms ORDER BY room_id"
    ) as cur:
        rooms: dict[str, list[str]] = {}
        for r in await cur.fetchall():
            rooms.setdefault(r["fireplace_id"], []).append(r["room_id"])
    async with conn.execute("SELECT * FROM fireplaces ORDER BY name COLLATE NOCASE") as cur:
        return [
            Fireplace(
                id=r["id"],
                name=r["name"],
                entity_id=r["entity_id"],
                cooldown_min=r["cooldown_min"],
                control=r["control"],
                room_ids=tuple(rooms.get(r["id"], [])),
                last_lit_at=(
                    None
                    if r["last_lit_at"] is None
                    else datetime.fromtimestamp(r["last_lit_at"], UTC)
                ),
            )
            for r in await cur.fetchall()
        ]


async def _parse(
    conn: aiosqlite.Connection, body: dict[str, Any], *, fireplace_id: str | None
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in body.items():
        if key == "name":
            if not isinstance(value, str) or not 0 < len(value.strip()) <= NAME_MAX:
                raise FireplaceError(BAD_NAME)
            out["name"] = value.strip()
            async with conn.execute(
                "SELECT id FROM fireplaces WHERE name = ? COLLATE NOCASE", (out["name"],)
            ) as cur:
                row = await cur.fetchone()
            if row is not None and row["id"] != fireplace_id:
                raise FireplaceError(NAME_TAKEN)
        elif key == "entity_id":
            if not isinstance(value, str) or value.split(".", 1)[0] not in SIGNAL_DOMAINS:
                raise FireplaceError(BAD_ENTITY)
            if "." not in value or not value.split(".", 1)[1]:
                raise FireplaceError(BAD_ENTITY)
            out["entity_id"] = value
        elif key == "room_ids":
            if (
                not isinstance(value, list)
                or not value
                or not all(isinstance(v, str) for v in value)
            ):
                raise FireplaceError(BAD_ROOMS)
            known = {r.id for r in await db.get_all_rooms(conn)}
            if not set(value) <= known:
                raise FireplaceError(ROOM_UNKNOWN)
            out["room_ids"] = sorted(set(value))
        elif key == "cooldown_min":
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not COOLDOWN_MIN <= value <= COOLDOWN_MAX
            ):
                raise FireplaceError(BAD_COOLDOWN)
            out["cooldown_min"] = value
        elif key == "control":
            if value not in CONTROLS:
                raise FireplaceError(BAD_CONTROL)
            out["control"] = value
        else:
            raise FireplaceError(UNKNOWN_FIELD)
    return out


async def _set_rooms(conn: aiosqlite.Connection, fireplace_id: str, room_ids: list[str]) -> None:
    await conn.execute("DELETE FROM fireplace_rooms WHERE fireplace_id = ?", (fireplace_id,))
    await conn.executemany(
        "INSERT INTO fireplace_rooms(fireplace_id, room_id) VALUES(?, ?)",
        [(fireplace_id, r) for r in room_ids],
    )


async def create(conn: aiosqlite.Connection, body: dict[str, Any]) -> str:
    parsed = await _parse(conn, body, fireplace_id=None)
    if not {"name", "entity_id", "room_ids"} <= set(parsed):
        raise FireplaceError(NAME_AND_ENTITY_NEEDED)
    fireplace_id = str(uuid.uuid4())
    await conn.execute(
        "INSERT INTO fireplaces(id, name, entity_id, cooldown_min, control) VALUES(?,?,?,?,?)",
        (
            fireplace_id,
            parsed["name"],
            parsed["entity_id"],
            parsed.get("cooldown_min", COOLDOWN_DEFAULT),
            parsed.get("control", "watch"),
        ),
    )
    await _set_rooms(conn, fireplace_id, parsed["room_ids"])
    await conn.commit()
    return fireplace_id


async def update(conn: aiosqlite.Connection, fireplace_id: str, body: dict[str, Any]) -> bool:
    """Change a fireplace; False when there is no such fireplace."""
    async with conn.execute("SELECT 1 FROM fireplaces WHERE id = ?", (fireplace_id,)) as cur:
        if await cur.fetchone() is None:
            return False
    parsed = await _parse(conn, body, fireplace_id=fireplace_id)
    rooms = parsed.pop("room_ids", None)
    for column, value in parsed.items():
        # Column names come from _parse's fixed set, never from the request.
        await conn.execute(
            f"UPDATE fireplaces SET {column} = ? WHERE id = ?", (value, fireplace_id)
        )
    if "entity_id" in parsed:
        # A different signal has no history: forget when the old one was last lit.
        await conn.execute("UPDATE fireplaces SET last_lit_at = NULL WHERE id = ?", (fireplace_id,))
    if rooms is not None:
        await _set_rooms(conn, fireplace_id, rooms)
    await conn.commit()
    return True


async def delete(conn: aiosqlite.Connection, fireplace_id: str) -> bool:
    await conn.execute("DELETE FROM fireplace_rooms WHERE fireplace_id = ?", (fireplace_id,))
    cur = await conn.execute("DELETE FROM fireplaces WHERE id = ?", (fireplace_id,))
    await conn.commit()
    return cur.rowcount > 0


@dataclass(frozen=True)
class Status:
    """One fireplace right now."""

    fireplace: Fireplace
    state: str
    lit_since: datetime | None
    cooling_until: datetime | None

    @property
    def warm(self) -> bool:
        return self.state in (LIT, COOLING)

    @property
    def setting_aside(self) -> bool:
        return self.warm and self.fireplace.control == "on"


@dataclass(frozen=True)
class Transition:
    fireplace: Fireplace
    state: str


class FireplaceMonitor:
    """Tracks which fireplaces are lit or cooling down."""

    def __init__(self) -> None:
        self._status: dict[str, Status] = {}
        self._lit_since: dict[str, datetime] = {}
        self._entities: frozenset[str] = frozenset()

    @property
    def entities(self) -> frozenset[str]:
        return self._entities

    def statuses(self) -> list[Status]:
        return sorted(self._status.values(), key=lambda s: s.fireplace.name.lower())

    def set_aside_rooms(self) -> dict[str, str]:
        """Room id -> name of the fireplace setting it aside."""
        return {
            room: s.fireplace.name
            for s in self.statuses()
            if s.setting_aside
            for room in s.fireplace.room_ids
        }

    def warmed_rooms(self) -> dict[str, bool]:
        """Every room a watched fireplace warms -> whether one is warm now."""
        out: dict[str, bool] = {}
        for s in self._status.values():
            if s.fireplace.control != "off":
                for room in s.fireplace.room_ids:
                    out[room] = out.get(room, False) or s.warm
        return out

    async def evaluate(
        self, conn: aiosqlite.Connection, get_state: Any, now: datetime
    ) -> list[Transition]:
        """Re-read every fireplace; returns the ones whose state changed."""
        fireplaces = await list_fireplaces(conn)
        self._entities = frozenset(f.entity_id for f in fireplaces)
        changes: list[Transition] = []
        seen: dict[str, Status] = {}
        for f in fireplaces:
            lit = is_lit(get_state(f.entity_id))
            last = f.last_lit_at
            if lit:
                self._lit_since.setdefault(f.id, now)
                last = now
                await conn.execute(
                    "UPDATE fireplaces SET last_lit_at = ? WHERE id = ?",
                    (int(now.timestamp()), f.id),
                )
            else:
                self._lit_since.pop(f.id, None)
            until = None if last is None else last + timedelta(minutes=f.cooldown_min)
            if lit:
                state = LIT
            elif until is not None and now < until:
                # Out, or the signal went quiet, while the room is still warm.
                state = COOLING
            else:
                state = UNKNOWN if lit is None else OUT
            status = Status(
                f, state, self._lit_since.get(f.id), until if state == COOLING else None
            )
            seen[f.id] = status
            before = self._status.get(f.id)
            if (before.state if before else OUT) != state and f.control != "off":
                changes.append(Transition(f, state))
        await conn.commit()
        for gone in set(self._lit_since) - set(seen):
            del self._lit_since[gone]
        self._status = seen
        return changes
