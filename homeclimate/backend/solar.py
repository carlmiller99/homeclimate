"""Where the sun is, how strong it is, and how much of it lands on a window.

The sun's position and the clear-sky strength are ported from RoomMind's
``control/solar.py`` (MIT licence, see THIRD_PARTY_NOTICES.md): the NOAA
simplified position equations and the Meinel clear-sky model. Pure maths, no
Home Assistant: the house's latitude and longitude are read once from its
``zone.home`` entity and remembered.

Azimuths are compass degrees: 0 north, 90 east, 180 south, 270 west.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Any

import aiosqlite

from . import db, shades

SOLAR_CONSTANT = 1361.0  # W/m² at the top of the atmosphere
LATITUDE_KEY = "site_latitude"
LONGITUDE_KEY = "site_longitude"


def position(latitude: float, longitude: float, when: datetime) -> tuple[float, float]:
    """The sun's (elevation, azimuth) in degrees; a negative elevation is night."""
    utc = when.astimezone(UTC)
    hour = utc.hour + utc.minute / 60.0 + utc.second / 3600.0
    # Fraction of the year, radians.
    gamma = 2.0 * math.pi * (utc.timetuple().tm_yday - 1 + (hour - 12.0) / 24.0) / 365.0
    # Equation of time, minutes.
    eqtime = 229.18 * (
        0.000075
        + 0.001868 * math.cos(gamma)
        - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2.0 * gamma)
        - 0.040849 * math.sin(2.0 * gamma)
    )
    # Declination, radians.
    decl = (
        0.006918
        - 0.399912 * math.cos(gamma)
        + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2.0 * gamma)
        + 0.000907 * math.sin(2.0 * gamma)
        - 0.002697 * math.cos(3.0 * gamma)
        + 0.00148 * math.sin(3.0 * gamma)
    )
    # True solar time and the hour angle.
    solar_minutes = hour * 60.0 + eqtime + 4.0 * longitude
    angle = math.radians(solar_minutes / 4.0 - 180.0)
    lat = math.radians(latitude)
    sin_elev = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(angle)
    sin_elev = max(-1.0, min(1.0, sin_elev))
    elevation = math.degrees(math.asin(sin_elev))
    cos_elev = math.cos(math.radians(elevation))
    if abs(cos_elev) < 1e-10 or abs(math.cos(lat)) < 1e-10:
        return elevation, 180.0  # straight overhead, or at a pole: any direction will do
    cos_az = (math.sin(lat) * sin_elev - math.sin(decl)) / (cos_elev * math.cos(lat))
    arc = math.degrees(math.acos(max(-1.0, min(1.0, cos_az))))
    # Morning (east of south) and afternoon (west of it).
    azimuth = (540.0 - arc) % 360.0 if angle < 0 else 180.0 + arc
    return elevation, azimuth


def clear_sky(elevation: float) -> float:
    """Sunlight on level ground under a clear sky, in kW/m²; 0 at night."""
    if elevation <= 0.0:
        return 0.0
    sin_elev = math.sin(math.radians(elevation))
    # Air mass (Kasten and Young, 1989), then the Meinel direct-beam model.
    air_mass = 1.0 / (sin_elev + 0.50572 * (elevation + 6.07995) ** (-1.6364))
    beam = SOLAR_CONSTANT * 0.7 ** (air_mass**0.678)
    return float(max(0.0, beam * sin_elev)) / 1000.0


def on_window(azimuth: float, elevation: float, facing: float) -> float:
    """The share (0 to 1) of the sunlight that lands on a window facing ``facing``."""
    if elevation <= 0:
        return 0.0
    return max(0.0, math.cos(math.radians(elevation)) * math.cos(math.radians(azimuth - facing)))


def gain(latitude: float, longitude: float, when: datetime, facings: Sequence[float]) -> float:
    """Sun on a room's windows, about 0 to 1: clear-sky strength times the windows' share.

    The average over the room's windows, so a corner room with two walls of
    glass is not counted twice as bright. 0 for a room with no known windows.
    """
    if not facings:
        return 0.0
    elevation, azimuth = position(latitude, longitude, when)
    strength = clear_sky(elevation)
    if strength <= 0.0:
        return 0.0
    return strength * sum(on_window(azimuth, elevation, f) for f in facings) / len(facings)


def _coordinate(value: Any, limit: float) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and abs(number) <= limit else None


async def remember_location(conn: aiosqlite.Connection, ha: Any) -> None:
    """Keep the house's latitude and longitude, from Home Assistant's ``zone.home``."""
    attrs = (ha.get_state("zone.home") or {}).get("attributes") or {}
    latitude = _coordinate(attrs.get("latitude"), 90.0)
    longitude = _coordinate(attrs.get("longitude"), 180.0)
    if latitude is None or longitude is None:
        return
    await db.set_system_setting(conn, LATITUDE_KEY, repr(latitude))
    await db.set_system_setting(conn, LONGITUDE_KEY, repr(longitude))


async def location(conn: aiosqlite.Connection) -> tuple[float, float] | None:
    """The house's (latitude, longitude), once Home Assistant has told us."""
    latitude = _coordinate(await db.get_system_setting(conn, LATITUDE_KEY, ""), 90.0)
    longitude = _coordinate(await db.get_system_setting(conn, LONGITUDE_KEY, ""), 180.0)
    if latitude is None or longitude is None:
        return None
    return latitude, longitude


async def for_rooms(conn: aiosqlite.Connection) -> dict[str, Callable[[datetime], float]]:
    """For each room with a window of known direction: the sun on its windows at a time.

    Windows are the room's shades (My Home), whether or not they are
    automated. Empty until the house's location is known.
    """
    where = await location(conn)
    if where is None:
        return {}
    facings: dict[str, list[float]] = {}
    for shade in await shades.list_shades(conn):
        facings.setdefault(shade.room_id, []).append(float(shades.FACINGS[shade.facing]))
    latitude, longitude = where

    def reader(found: list[float]) -> Callable[[datetime], float]:
        return lambda when: gain(latitude, longitude, when, found)

    return {room_id: reader(found) for room_id, found in facings.items()}
