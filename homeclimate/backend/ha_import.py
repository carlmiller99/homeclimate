"""Set Up from Home Assistant: preview and import (HomeClimate phase 5).

``build_preview`` is pure: it turns HA's registries and states plus what
HomeClimate already has into suggestions. ``apply_import`` writes the reviewed
choices. Importing only ever adds — it never deletes or renames a room,
sensor, vent or zone that already exists.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import aiosqlite

from . import db, zones
from .models import Room, RoomPresenceSensor, RoomSensor, RoomVent, ThermostatConfig
from .mqtt.naming import sanitize

SKIPPED_AREAS_KEY = "ha_import_skipped_areas"

TEMPERATURE_UNITS = ("°F", "°C")
PRESENCE_CLASSES = ("occupancy", "presence", "motion")
CONTACT_CLASSES = ("door", "window", "opening", "garage_door")
SHADE_CLASSES = ("shade", "blind", "curtain", "awning", "shutter")
VENT_CLASSES = ("damper",)


class ImportError_(ValueError):  # noqa: N801 — avoid shadowing the builtin
    """A user-facing import validation error with a fixed, safe message."""


@dataclass
class Found:
    temperature: list[str] = field(default_factory=list)
    presence: list[str] = field(default_factory=list)
    contacts: list[str] = field(default_factory=list)
    shades: list[str] = field(default_factory=list)
    vents: list[str] = field(default_factory=list)

    def any(self) -> bool:
        return bool(self.temperature or self.presence or self.contacts or self.shades or self.vents)

    def as_dict(self) -> dict[str, list[str]]:
        return {
            "temperature": self.temperature,
            "presence": self.presence,
            "contacts": self.contacts,
            "shades": self.shades,
            "vents": self.vents,
        }


def _entity_areas(registries: dict[str, list[dict]]) -> tuple[dict[str, str], set[str]]:
    """entity_id → area_id (entity's own area, else its device's) and the
    set of entities that are disabled, hidden or diagnostic/config."""
    device_area = {d.get("id"): d.get("area_id") for d in registries.get("devices", [])}
    areas: dict[str, str] = {}
    excluded: set[str] = set()
    for e in registries.get("entities", []):
        eid = e.get("entity_id")
        if not eid:
            continue
        if e.get("disabled_by") or e.get("hidden_by") or e.get("entity_category"):
            excluded.add(eid)
        area = e.get("area_id") or device_area.get(e.get("device_id"))
        if area:
            areas[eid] = area
    return areas, excluded


def _classify(state: dict) -> str | None:
    eid: str = state.get("entity_id", "")
    attrs = state.get("attributes", {}) or {}
    cls = attrs.get("device_class")
    domain = eid.split(".", 1)[0]
    if (
        domain == "sensor"
        and cls == "temperature"
        and attrs.get("unit_of_measurement") in TEMPERATURE_UNITS
    ):
        return "temperature"
    if domain == "binary_sensor" and cls in PRESENCE_CLASSES:
        return "presence"
    if domain == "binary_sensor" and cls in CONTACT_CLASSES:
        return "contacts"
    if domain == "cover" and cls in SHADE_CLASSES:
        return "shades"
    if domain == "cover" and (cls in VENT_CLASSES or "vent" in eid.split(".", 1)[1]):
        return "vents"
    return None


def build_preview(
    registries: dict[str, list[dict]],
    states: list[dict],
    existing_rooms: list[Room],
    existing_thermostats: list[ThermostatConfig],
    existing_entities: set[str],
    skipped_areas: set[str],
) -> dict[str, Any]:
    """Suggestions for zones (one per climate entity) and rooms (one per area)."""
    area_names: dict[str, str] = {
        str(a["area_id"]): str(a.get("name") or a["area_id"])
        for a in registries.get("areas", [])
        if a.get("area_id")
    }
    floor_names = {f.get("floor_id"): f.get("name") for f in registries.get("floors", [])}
    area_floor = {a.get("area_id"): a.get("floor_id") for a in registries.get("areas", [])}
    entity_area, excluded = _entity_areas(registries)
    configured = {t.thermostat_entity_id: t for t in existing_thermostats}

    zone_rows = []
    labels: dict[str, str] = {}
    climate_area: dict[str, str] = {}
    by_area: dict[str, Found] = {aid: Found() for aid in area_names}
    for s in sorted(states, key=lambda x: x.get("entity_id", "")):
        eid = s.get("entity_id", "")
        if eid in excluded:
            continue
        area = entity_area.get(eid)
        if eid.startswith("climate."):
            if area:
                climate_area[eid] = area
            floor = floor_names.get(area_floor.get(area)) if area else None
            tc = configured.get(eid)
            zone_rows.append(
                {
                    "entity_id": eid,
                    "friendly_name": (s.get("attributes") or {}).get("friendly_name") or eid,
                    "area_id": area,
                    "area_name": area_names.get(area) if area else None,
                    "floor_name": floor,
                    "suggested_name": (tc.name if tc and tc.name else None)
                    or floor
                    or (area_names.get(area) if area else None)
                    or (s.get("attributes") or {}).get("friendly_name")
                    or eid,
                    "configured": tc is not None,
                }
            )
            continue
        kind = _classify(s)
        if kind is None or area is None or area not in by_area:
            continue
        getattr(by_area[area], kind).append(eid)
        labels[eid] = str((s.get("attributes") or {}).get("friendly_name") or eid)

    rooms_by_key = {sanitize(r.name): r for r in existing_rooms}
    room_rows = []
    for aid, name in sorted(area_names.items(), key=lambda kv: str(kv[1]).lower()):
        found = by_area[aid]
        existing = rooms_by_key.get(sanitize(str(name)))
        zone_here = next((c for c, a in climate_area.items() if a == aid), None)
        room_rows.append(
            {
                "area_id": aid,
                "area_name": name,
                "found": found.as_dict(),
                "new_entities": [
                    e
                    for e in found.temperature + found.presence + found.vents
                    if e not in existing_entities
                ],
                "existing_room_id": existing.id if existing else None,
                "suggested_zone": (existing.thermostat_entity_id if existing else None)
                or zone_here,
                "skipped": aid in skipped_areas or not found.any(),
            }
        )
    return {
        "zones": zone_rows,
        "rooms": room_rows,
        "labels": labels,
        "room_names": sorted(
            {r.name for r in existing_rooms} | {str(n) for n in area_names.values()}
        ),
    }


def _str_list(raw: Any, name: str) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(x, str) and "." in x for x in raw):
        raise ImportError_(f"{name} must be a list of entity ids")
    return list(dict.fromkeys(raw))


@dataclass
class ImportResult:
    zones_added: int = 0
    buildings_added: int = 0
    rooms_added: int = 0
    rooms_updated: int = 0
    entities_added: int = 0

    def as_dict(self) -> dict[str, int]:
        return dict(self.__dict__)


async def _building_for(
    conn: aiosqlite.Connection, row: dict, result: ImportResult, cache: dict[str, str]
) -> str | None:
    if row.get("building_id"):
        bid = row["building_id"]
        if not isinstance(bid, str) or await zones.get_building(conn, bid) is None:
            raise ImportError_("building_id does not match a building")
        return bid
    new_name = row.get("new_building_name")
    if not new_name:
        return None
    clean = zones.clean_name(new_name)
    key = clean.lower()
    if key in cache:
        return cache[key]
    for b in await zones.list_buildings(conn):
        if b.name.lower() == key:
            cache[key] = b.id
            return b.id
    building = await zones.create_building(conn, clean)
    result.buildings_added += 1
    cache[key] = building.id
    return building.id


async def apply_import(
    conn: aiosqlite.Connection, body: dict[str, Any], known_climates: set[str]
) -> ImportResult:
    """Create zones and rooms from reviewed choices. Additive only."""
    zone_rows = body.get("zones") or []
    room_rows = body.get("rooms") or []
    skipped = body.get("skipped_areas")
    if not isinstance(zone_rows, list) or not isinstance(room_rows, list):
        raise ImportError_("zones and rooms must be lists")
    result = ImportResult()
    building_cache: dict[str, str] = {}

    configured = {t.thermostat_entity_id for t in await db.get_all_thermostat_configs(conn)}
    for row in zone_rows:
        if not isinstance(row, dict):
            raise ImportError_("each zone must be an object")
        eid = row.get("entity_id")
        if eid not in known_climates:
            raise ImportError_("a zone's entity_id is not a Home Assistant thermostat")
        name = zones.clean_name(row.get("name") or eid)
        if eid not in configured:
            await db.upsert_thermostat_config(
                conn, ThermostatConfig(thermostat_entity_id=eid, name=name)
            )
            configured.add(eid)
            result.zones_added += 1
        building_id = await _building_for(conn, row, result, building_cache)
        if building_id is not None:
            await zones.update_zone_profile(conn, eid, {"building_id": building_id})

    rooms = await db.get_all_rooms(conn)
    by_key = {sanitize(r.name): r for r in rooms}
    for row in room_rows:
        if not isinstance(row, dict):
            raise ImportError_("each room must be an object")
        name = zones.clean_name(row.get("name"))
        key = sanitize(name)
        if not key:
            raise ImportError_("a room name must contain a letter or number")
        zone = row.get("zone")
        if zone not in configured:
            raise ImportError_("each room needs a zone that exists")
        sensors = _str_list(row.get("sensors"), "sensors")
        presence = _str_list(row.get("presence"), "presence")
        vents = _str_list(row.get("vents"), "vents")
        room = by_key.get(key)
        if room is None:
            room = Room.create(name=name, thermostat_entity_id=zone)
            await db.upsert_room(conn, room)
            by_key[key] = room
            result.rooms_added += 1
            have: set[str] = set()
        else:
            have = {s.entity_id for s in await db.get_room_sensors(conn, room.id)}
            have |= {p.entity_id for p in await db.get_room_presence_sensors(conn, room.id)}
            have |= {v.entity_id for v in await db.get_room_vents(conn, room.id)}
            result.rooms_updated += 1
        for eid in sensors:
            if eid not in have:
                await db.add_room_sensor(conn, RoomSensor.create(room.id, eid))
                result.entities_added += 1
        for eid in presence:
            if eid not in have:
                await db.add_room_presence_sensor(conn, RoomPresenceSensor.create(room.id, eid))
                result.entities_added += 1
        for eid in vents:
            if eid not in have:
                await db.add_room_vent(conn, RoomVent.create(room.id, eid))
                result.entities_added += 1

    if skipped is not None:
        if not isinstance(skipped, list) or not all(isinstance(a, str) for a in skipped):
            raise ImportError_("skipped_areas must be a list of area ids")
        await db.set_system_setting(conn, SKIPPED_AREAS_KEY, json.dumps(sorted(set(skipped))))
    return result


async def load_skipped_areas(conn: aiosqlite.Connection) -> set[str]:
    raw = await db.get_system_setting(conn, SKIPPED_AREAS_KEY, "[]")
    try:
        value = json.loads(raw)
    except ValueError:
        return set()
    return {a for a in value if isinstance(a, str)} if isinstance(value, list) else set()
