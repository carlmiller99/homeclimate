"""The house's outside temperature: one sensor, or the average of several.

The setting ``outside_temperature_entity_id`` holds the chosen Home Assistant
entities as a comma-separated list. A single id reads exactly as it always
has, so an install set up before several were allowed needs no change.

Every reader goes through :func:`read`, so the engine, the recorder, the
metrics and the settings page can never disagree about what "outside" is.
"""

from __future__ import annotations

import math
from typing import Any

import aiosqlite

from . import db

SETTING = "outside_temperature_entity_id"

# More than a handful is a mistake, not a weather station.
MAX_SENSORS = 8


def parse(raw: str | None) -> list[str]:
    """The entity ids in a stored value, in order, without blanks or repeats."""
    seen: list[str] = []
    for part in (raw or "").split(","):
        entity_id = part.strip()
        if entity_id and entity_id not in seen:
            seen.append(entity_id)
    return seen


async def entity_ids(conn: aiosqlite.Connection) -> list[str]:
    return parse(await db.get_system_setting(conn, SETTING, ""))


async def store(conn: aiosqlite.Connection, ids: list[str]) -> None:
    await db.set_system_setting(conn, SETTING, ",".join(parse(",".join(ids))))


def readings(ha: Any, ids: list[str]) -> dict[str, float | None]:
    """Each sensor's reading in °F, or None for one that cannot be read."""
    found: dict[str, float | None] = {}
    for entity_id in ids:
        try:
            value = ha.get_numeric_state(entity_id)
        except Exception:
            value = None
        # A sensor reporting "nan" or "inf" parses as a number but would
        # poison the average and make every comparison with it false.
        usable = isinstance(value, (int, float)) and math.isfinite(value)
        found[entity_id] = float(value) if usable else None
    return found


def average(values: dict[str, float | None]) -> float | None:
    """The mean of the sensors that answered; None when none did.

    A sensor that is offline is left out rather than failing the lot: two
    working thermometers out of three still say what it is like outside.
    """
    good = [v for v in values.values() if v is not None]
    return sum(good) / len(good) if good else None


async def read(conn: aiosqlite.Connection, ha: Any) -> float | None:
    """The outside temperature in °F right now, or None if unset or unreadable."""
    return average(readings(ha, await entity_ids(conn)))
