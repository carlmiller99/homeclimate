"""Buildings and zone profiles (HomeClimate).

A *zone* is one thermostat. Zones belong to an optional *building*, and carry
an equipment profile (conventional or heat pump, compressor stages, backup
heat, an optional "equipment running" entity). Kept out of
``thermostat_configs`` so the existing tuning row and its MQTT/parity
contracts are unaffected.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import aiosqlite

from .user_errors import UserError, fixed

SYSTEM_TYPES = ("conventional", "heat_pump")
BACKUP_HEAT = ("electric", "gas", "none")
MAX_STAGES = 3
MAX_NAME_LEN = 60


@dataclass
class Building:
    id: str
    name: str
    sort_order: int = 0


@dataclass
class ZoneProfile:
    thermostat_entity_id: str
    name: str = ""
    building_id: str | None = None
    sort_order: int = 0
    system_type: str = "conventional"
    compressor_stages: int = 1
    backup_heat: str = "electric"
    equipment_running_entity: str | None = None
    heat_kit_confirmed: bool = False
    # Heat pump protection (°F; step and rate are deltas).
    hp_max_step_f: float = 1.0
    hp_recovery_f_per_hr: float = 2.0
    hp_min_runtime_min: int = 15
    hp_min_open_heat_pct: int = 50
    hp_switchover_gap_min: int = 60
    hp_compressor_lockout_f: float | None = None

    @property
    def is_heat_pump(self) -> bool:
        return self.system_type == "heat_pump"


class ZoneError(UserError):
    """A user-facing validation error with a fixed, safe message."""


NAME_REQUIRED = fixed("name is required")
NAME_TOO_LONG = fixed(f"name must be at most {MAX_NAME_LEN} characters")
BUILDING_EXISTS = fixed("a building with that name already exists")
BUILDING_UNKNOWN = fixed("building_id does not match a building")
ENTITY_INVALID = fixed("equipment_running_entity must be an entity id or null")
HEAT_KIT_INVALID = fixed("heat_kit_confirmed must be true or false")
_INT_LIMITS = {
    "sort_order": (0, 999),
    "compressor_stages": (1, MAX_STAGES),
    "hp_min_runtime_min": (0, 60),
    "hp_min_open_heat_pct": (0, 100),
    "hp_switchover_gap_min": (0, 240),
}
# °F bounds for the heat pump temperature guards (already converted to °F).
_FLOAT_LIMITS = {
    "hp_max_step_f": (0.5, 5.0),
    "hp_recovery_f_per_hr": (0.5, 10.0),
    "hp_compressor_lockout_f": (-40.0, 70.0),
}
_FLOAT_MESSAGES = {
    "hp_max_step_f": fixed("Max Setpoint Step must be between 0.5 and 5 °F (0.3 and 2.8 °C)"),
    "hp_recovery_f_per_hr": fixed(
        "Max Recovery Rate must be between 0.5 and 10 °F (0.3 and 5.6 °C) per hour"
    ),
    "hp_compressor_lockout_f": fixed(
        "Compressor Lockout Below must be between -40 and 70 °F (-40 and 21 °C), or empty"
    ),
}
_INT_MESSAGES = {
    name: fixed(f"{name} must be a whole number from {lo} to {hi}")
    for name, (lo, hi) in _INT_LIMITS.items()
}
_CHOICES = {"system_type": SYSTEM_TYPES, "backup_heat": BACKUP_HEAT}
_CHOICE_MESSAGES = {
    name: fixed(f"{name} must be one of: {', '.join(options)}")
    for name, options in _CHOICES.items()
}


def _building(row: aiosqlite.Row) -> Building:
    return Building(id=row["id"], name=row["name"], sort_order=int(row["sort_order"]))


async def list_buildings(conn: aiosqlite.Connection) -> list[Building]:
    async with conn.execute(
        "SELECT * FROM buildings ORDER BY sort_order, name COLLATE NOCASE"
    ) as cur:
        return [_building(r) for r in await cur.fetchall()]


async def get_building(conn: aiosqlite.Connection, building_id: str) -> Building | None:
    async with conn.execute("SELECT * FROM buildings WHERE id=?", (building_id,)) as cur:
        row = await cur.fetchone()
    return _building(row) if row else None


def clean_name(raw: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ZoneError(NAME_REQUIRED)
    name = " ".join(raw.split())
    if len(name) > MAX_NAME_LEN:
        raise ZoneError(NAME_TOO_LONG)
    return name


async def _name_taken(conn: aiosqlite.Connection, name: str, exclude_id: str | None) -> bool:
    async with conn.execute(
        "SELECT id FROM buildings WHERE name=? COLLATE NOCASE AND id IS NOT ?",
        (name, exclude_id),
    ) as cur:
        return await cur.fetchone() is not None


async def create_building(conn: aiosqlite.Connection, raw_name: Any) -> Building:
    name = clean_name(raw_name)
    if await _name_taken(conn, name, None):
        raise ZoneError(BUILDING_EXISTS)
    async with conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM buildings") as cur:
        row = await cur.fetchone()
    next_order = int(row[0]) if row else 0
    building = Building(id=str(uuid.uuid4()), name=name, sort_order=next_order)
    await conn.execute(
        "INSERT INTO buildings(id, name, sort_order) VALUES(?,?,?)",
        (building.id, building.name, building.sort_order),
    )
    await conn.commit()
    return building


async def update_building(
    conn: aiosqlite.Connection, building_id: str, changes: dict[str, Any]
) -> Building | None:
    building = await get_building(conn, building_id)
    if building is None:
        return None
    if "name" in changes:
        name = clean_name(changes["name"])
        if await _name_taken(conn, name, building_id):
            raise ZoneError(BUILDING_EXISTS)
        building.name = name
    if "sort_order" in changes:
        building.sort_order = _int(changes["sort_order"], "sort_order")
    await conn.execute(
        "UPDATE buildings SET name=?, sort_order=? WHERE id=?",
        (building.name, building.sort_order, building_id),
    )
    await conn.commit()
    return building


async def delete_building(conn: aiosqlite.Connection, building_id: str) -> str:
    """Delete a building. Returns "deleted", "missing" or "in_use"."""
    if await get_building(conn, building_id) is None:
        return "missing"
    async with conn.execute(
        "SELECT 1 FROM zone_profiles WHERE building_id=? LIMIT 1", (building_id,)
    ) as cur:
        if await cur.fetchone():
            return "in_use"
    await conn.execute("DELETE FROM buildings WHERE id=?", (building_id,))
    await conn.commit()
    return "deleted"


def _int(raw: Any, name: str) -> int:
    lo, hi = _INT_LIMITS[name]
    if isinstance(raw, bool) or not isinstance(raw, int) or not lo <= raw <= hi:
        raise ZoneError(_INT_MESSAGES[name])
    return raw


def _float(raw: Any, name: str) -> float:
    lo, hi = _FLOAT_LIMITS[name]
    if isinstance(raw, bool) or not isinstance(raw, int | float) or not lo <= raw <= hi:
        raise ZoneError(_FLOAT_MESSAGES[name])
    return round(float(raw), 2)


def _choice(raw: Any, name: str) -> str:
    if raw not in _CHOICES[name]:
        raise ZoneError(_CHOICE_MESSAGES[name])
    return str(raw)


async def list_zone_profiles(conn: aiosqlite.Connection) -> list[ZoneProfile]:
    """Every configured thermostat as a zone, with defaults where no profile row exists."""
    async with conn.execute(
        """SELECT t.thermostat_entity_id AS eid, t.name AS tname, z.*
           FROM thermostat_configs t
           LEFT JOIN zone_profiles z ON z.thermostat_entity_id = t.thermostat_entity_id
           ORDER BY COALESCE(z.sort_order, 0), t.name COLLATE NOCASE, t.thermostat_entity_id"""
    ) as cur:
        rows = await cur.fetchall()
    return [_profile(r) for r in rows]


async def get_zone_profile(conn: aiosqlite.Connection, entity_id: str) -> ZoneProfile | None:
    async with conn.execute(
        """SELECT t.thermostat_entity_id AS eid, t.name AS tname, z.*
           FROM thermostat_configs t
           LEFT JOIN zone_profiles z ON z.thermostat_entity_id = t.thermostat_entity_id
           WHERE t.thermostat_entity_id=?""",
        (entity_id,),
    ) as cur:
        row = await cur.fetchone()
    return _profile(row) if row else None


def _profile(row: aiosqlite.Row) -> ZoneProfile:
    has_row = row["system_type"] is not None
    return ZoneProfile(
        thermostat_entity_id=row["eid"],
        name=row["tname"] or "",
        building_id=row["building_id"] if has_row else None,
        sort_order=int(row["sort_order"]) if has_row else 0,
        system_type=row["system_type"] if has_row else "conventional",
        compressor_stages=int(row["compressor_stages"]) if has_row else 1,
        backup_heat=row["backup_heat"] if has_row else "electric",
        equipment_running_entity=row["equipment_running_entity"] if has_row else None,
        heat_kit_confirmed=bool(row["heat_kit_confirmed"]) if has_row else False,
        **(
            {
                "hp_max_step_f": float(row["hp_max_step_f"]),
                "hp_recovery_f_per_hr": float(row["hp_recovery_f_per_hr"]),
                "hp_min_runtime_min": int(row["hp_min_runtime_min"]),
                "hp_min_open_heat_pct": int(row["hp_min_open_heat_pct"]),
                "hp_switchover_gap_min": int(row["hp_switchover_gap_min"]),
                "hp_compressor_lockout_f": row["hp_compressor_lockout_f"],
            }
            if has_row
            else {}
        ),
    )


async def update_zone_profile(
    conn: aiosqlite.Connection, entity_id: str, changes: dict[str, Any]
) -> ZoneProfile | None:
    """Apply a partial update. Returns None when the thermostat isn't configured."""
    zone = await get_zone_profile(conn, entity_id)
    if zone is None:
        return None
    if "building_id" in changes:
        bid = changes["building_id"]
        if bid is not None and (not isinstance(bid, str) or await get_building(conn, bid) is None):
            raise ZoneError(BUILDING_UNKNOWN)
        zone.building_id = bid
    if "sort_order" in changes:
        zone.sort_order = _int(changes["sort_order"], "sort_order")
    if "system_type" in changes:
        zone.system_type = _choice(changes["system_type"], "system_type")
    if "compressor_stages" in changes:
        zone.compressor_stages = _int(changes["compressor_stages"], "compressor_stages")
    if "backup_heat" in changes:
        zone.backup_heat = _choice(changes["backup_heat"], "backup_heat")
    if "equipment_running_entity" in changes:
        ent = changes["equipment_running_entity"] or None
        if ent is not None and (not isinstance(ent, str) or "." not in ent):
            raise ZoneError(ENTITY_INVALID)
        zone.equipment_running_entity = ent
    if "heat_kit_confirmed" in changes:
        if not isinstance(changes["heat_kit_confirmed"], bool):
            raise ZoneError(HEAT_KIT_INVALID)
        zone.heat_kit_confirmed = changes["heat_kit_confirmed"]
    for name in ("hp_min_runtime_min", "hp_min_open_heat_pct", "hp_switchover_gap_min"):
        if name in changes:
            setattr(zone, name, _int(changes[name], name))
    for name in ("hp_max_step_f", "hp_recovery_f_per_hr"):
        if name in changes:
            setattr(zone, name, _float(changes[name], name))
    if "hp_compressor_lockout_f" in changes:
        raw = changes["hp_compressor_lockout_f"]
        zone.hp_compressor_lockout_f = (
            None if raw is None else _float(raw, "hp_compressor_lockout_f")
        )
    await conn.execute(
        """INSERT INTO zone_profiles(thermostat_entity_id, building_id, sort_order, system_type,
               compressor_stages, backup_heat, equipment_running_entity, heat_kit_confirmed,
               hp_max_step_f, hp_recovery_f_per_hr, hp_min_runtime_min,
               hp_min_open_heat_pct, hp_switchover_gap_min, hp_compressor_lockout_f)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(thermostat_entity_id) DO UPDATE SET
             building_id=excluded.building_id, sort_order=excluded.sort_order,
             system_type=excluded.system_type, compressor_stages=excluded.compressor_stages,
             backup_heat=excluded.backup_heat,
             equipment_running_entity=excluded.equipment_running_entity,
             heat_kit_confirmed=excluded.heat_kit_confirmed,
             hp_max_step_f=excluded.hp_max_step_f,
             hp_recovery_f_per_hr=excluded.hp_recovery_f_per_hr,
             hp_min_runtime_min=excluded.hp_min_runtime_min,
             hp_min_open_heat_pct=excluded.hp_min_open_heat_pct,
             hp_switchover_gap_min=excluded.hp_switchover_gap_min,
             hp_compressor_lockout_f=excluded.hp_compressor_lockout_f""",
        (
            entity_id,
            zone.building_id,
            zone.sort_order,
            zone.system_type,
            zone.compressor_stages,
            zone.backup_heat,
            zone.equipment_running_entity,
            int(zone.heat_kit_confirmed),
            zone.hp_max_step_f,
            zone.hp_recovery_f_per_hr,
            zone.hp_min_runtime_min,
            zone.hp_min_open_heat_pct,
            zone.hp_switchover_gap_min,
            zone.hp_compressor_lockout_f,
        ),
    )
    await conn.commit()
    return zone


def as_dict(obj: Building | ZoneProfile) -> dict[str, Any]:
    return dict(obj.__dict__)
