"""My Home structure rules, shared by the REST API and the stdio MCP tools.

Every room belongs to a zone (a registered thermostat). A zone may be empty: it
is simply not controlled until it has a room (the scheduler only runs an engine
for a thermostat that has rooms, and ends a running cycle cleanly when the last
one goes). Both transports write rooms, so the rules live here rather than in
either of them.
"""

from __future__ import annotations

from typing import Any

import aiosqlite

from . import db
from .models import ThermostatConfig

ROOM_NEEDS_ZONE = "Choose a zone for the room."
BAD_ZONE_ID = "A zone's thermostat must be a climate entity, such as climate.upstairs."
ZONE_HAS_ROOMS = (
    "This zone still has rooms. Delete it with its rooms (with_rooms=true), "
    "or move the rooms to another zone first."
)

_CLIMATE = "climate."


def zone_id_problem(thermostat_entity_id: Any) -> str | None:
    """Why ``thermostat_entity_id`` cannot name a zone, or None when it can."""
    if not isinstance(thermostat_entity_id, str) or not thermostat_entity_id:
        return ROOM_NEEDS_ZONE
    if not thermostat_entity_id.startswith(_CLIMATE) or len(thermostat_entity_id) == len(_CLIMATE):
        return BAD_ZONE_ID
    return None


async def zone_registered(conn: aiosqlite.Connection, thermostat_entity_id: str) -> bool:
    async with conn.execute(
        "SELECT 1 FROM thermostat_configs WHERE thermostat_entity_id=?", (thermostat_entity_id,)
    ) as cur:
        return await cur.fetchone() is not None


async def ensure_zone(conn: aiosqlite.Connection, entity_id: str) -> bool:
    """Register ``entity_id`` as a zone with default settings if it is not one yet.

    Returns True when a zone was created. Call it only once the room write that
    needs the zone can no longer be rejected, so a refused room never leaves an
    empty zone behind.
    """
    if await zone_registered(conn, entity_id):
        return False
    await db.upsert_thermostat_config(conn, ThermostatConfig(thermostat_entity_id=entity_id))
    return True
