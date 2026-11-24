"""HomeClimate REST endpoints: buildings and zones.

Registered on the shared ``routes`` table, so they get OpenAPI docs, the auth
and CSRF middleware, MCP tools and the API-spec enforcement test for free.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta

from aiohttp import web

from .. import db, fireplace, forecast, ha_import, heat_pump, learning, openings, shades, tz, zones
from ..units import delta_to_f, to_f
from ..user_errors import UserError, safe_text
from . import schemas
from .openapi import docs, query_params, request_schema, response_schema
from .routes import (
    _DATE_RANGE_QUERY_PARAMS,
    TEMPERATURE_FIELDS,
    _parse_date_range,
    emit,
    error,
    get_conn,
    json_response,
    refresh,
    routes,
)

log = logging.getLogger(__name__)


async def _json_object(request: web.Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise web.HTTPBadRequest(
            text='{"error": "request body must be JSON"}', content_type="application/json"
        ) from None
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(
            text='{"error": "request body must be a JSON object"}', content_type="application/json"
        )
    return body


@docs(tags=["buildings"], summary="List buildings")
@response_schema(schemas.BuildingSchema(many=True))
@routes.get("/api/buildings")
async def list_buildings(request: web.Request) -> web.Response:
    conn = await get_conn(request)
    return json_response([zones.as_dict(b) for b in await zones.list_buildings(conn)])


@docs(tags=["buildings"], summary="Add a building")
@request_schema(schemas.BuildingWriteSchema)
@response_schema(schemas.BuildingSchema, 201)
@routes.post("/api/buildings")
async def create_building(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    try:
        building = await zones.create_building(conn, body.get("name"))
    except zones.ZoneError as exc:
        return error(safe_text(exc))
    await emit(request, "info", "api", f"Building added: {building.name}", {"id": building.id})
    return json_response(zones.as_dict(building), status=201)


@docs(tags=["buildings"], summary="Rename or reorder a building")
@request_schema(schemas.BuildingWriteSchema)
@response_schema(schemas.BuildingSchema)
@routes.put("/api/buildings/{building_id}")
async def update_building(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    try:
        building = await zones.update_building(conn, request.match_info["building_id"], body)
    except zones.ZoneError as exc:
        return error(safe_text(exc))
    if building is None:
        return error("Building not found", status=404)
    return json_response(zones.as_dict(building))


@docs(tags=["buildings"], summary="Delete a building that has no zones")
@response_schema(schemas.DeletedSchema)
@routes.delete("/api/buildings/{building_id}")
async def delete_building(request: web.Request) -> web.Response:
    building_id = request.match_info["building_id"]
    conn = await get_conn(request)
    outcome = await zones.delete_building(conn, building_id)
    if outcome == "missing":
        return error("Building not found", status=404)
    if outcome == "in_use":
        return error("Move this building's zones to another building first", status=409)
    return json_response({"deleted": building_id})


@docs(tags=["zones"], summary="List zones (one per thermostat) with building and equipment")
@response_schema(schemas.ZoneProfileSchema(many=True))
@routes.get("/api/zones")
async def list_zones(request: web.Request) -> web.Response:
    conn = await get_conn(request)
    scheduler = request.app["scheduler"]
    return json_response(
        [
            {
                **zones.as_dict(z),
                "aux_heat_running": scheduler.aux_heat_running(z.thermostat_entity_id),
                "strips_expected": scheduler.strips_expected(z.thermostat_entity_id),
            }
            for z in await zones.list_zone_profiles(conn)
        ]
    )


@docs(tags=["zones"], summary="Update a zone's building, order or equipment profile")
@request_schema(schemas.ZoneProfileWriteSchema)
@response_schema(schemas.ZoneProfileSchema)
@routes.put("/api/zones/{entity_id:[^/]+}")
async def update_zone(request: web.Request) -> web.Response:
    body = await _json_object(request)
    entity_id = request.match_info["entity_id"]
    # The write boundary converts display-unit temperatures to °F (#231).
    unit = request.app["scheduler"].get_temperature_unit()
    for name in ("hp_max_step_f", "hp_recovery_f_per_hr", "hp_compressor_lockout_f"):
        value = body.get(name)
        if isinstance(value, int | float) and not isinstance(value, bool):
            kind = TEMPERATURE_FIELDS[name]
            body[name] = (
                to_f(value, unit) if kind.startswith("absolute") else delta_to_f(value, unit)
            )
    conn = await get_conn(request)
    try:
        zone = await zones.update_zone_profile(conn, entity_id, body)
    except zones.ZoneError as exc:
        return error(safe_text(exc))
    if zone is None:
        return error("Zone not found", status=404)
    await refresh(request)
    return json_response(zones.as_dict(zone))


# ---------------------------------------------------------------------------
# Set Up from Home Assistant
# ---------------------------------------------------------------------------

HA_UNAVAILABLE = "Home Assistant's registries could not be read"


@docs(tags=["import"], summary="Preview zones and rooms that can be imported from Home Assistant")
@response_schema(schemas.ImportPreviewSchema)
@routes.get("/api/ha/import-preview")
async def import_preview(request: web.Request) -> web.Response:
    ha = request.app["ha"]
    try:
        registries = await ha.get_registries()
    except Exception:
        log.exception("Failed to read HA registries for the import preview")
        return error(HA_UNAVAILABLE, status=503)
    conn = await get_conn(request)
    rooms = await db.get_all_rooms(conn)
    existing: set[str] = set()
    for room in rooms:
        existing |= {s.entity_id for s in await db.get_room_sensors(conn, room.id)}
        existing |= {p.entity_id for p in await db.get_room_presence_sensors(conn, room.id)}
        existing |= {v.entity_id for v in await db.get_room_vents(conn, room.id)}
    existing |= {c.entity_id for c in await openings.list_contacts(conn)}
    preview = ha_import.build_preview(
        registries,
        ha.all_states(),
        rooms,
        await db.get_all_thermostat_configs(conn),
        existing,
        await ha_import.load_skipped_areas(conn),
    )
    return json_response(preview)


@docs(tags=["import"], summary="Create zones and rooms from a reviewed import (additive only)")
@request_schema(schemas.ImportRequestSchema)
@response_schema(schemas.ImportResultSchema)
@routes.post("/api/ha/import")
async def run_import(request: web.Request) -> web.Response:
    body = await _json_object(request)
    climates = {
        s["entity_id"]
        for s in request.app["ha"].all_states()
        if s.get("entity_id", "").startswith("climate.")
    }
    conn = await get_conn(request)
    try:
        result = await ha_import.apply_import(conn, body, climates)
    except UserError as exc:
        return error(safe_text(exc))
    await refresh(request)
    await emit(
        request, "info", "api", "Imported zones and rooms from Home Assistant", result.as_dict()
    )
    return json_response(result.as_dict())


# ---------------------------------------------------------------------------
# Smart Control: doors and windows
# ---------------------------------------------------------------------------


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


async def _smart_control_snapshot(request: web.Request) -> dict:
    conn = await get_conn(request)
    scheduler = request.app["scheduler"]
    monitor: openings.OpeningMonitor = scheduler.openings
    ha = request.app["ha"]
    sensors = []
    room_zone = {r.id: r.thermostat_entity_id for r in await db.get_all_rooms(conn)}
    for c in await openings.list_contacts(conn):
        state = ha.get_state(c.entity_id)
        attrs = (state or {}).get("attributes") or {}
        zone_id = c.thermostat_entity_id or room_zone.get(str(c.room_id))
        scope = ("zone", str(zone_id)) if c.pauses == "zone" else ("room", str(c.room_id))
        kind = openings.classify(state)
        sensors.append(
            {
                "entity_id": c.entity_id,
                "name": attrs.get("friendly_name") or c.entity_id,
                "thermostat_entity_id": zone_id,
                "room_id": c.room_id,
                "pauses": c.pauses,
                "state": kind,
                "open_since": _iso(monitor.open_since(c.entity_id)) if kind == "open" else None,
                "pausing": kind == "open" and monitor.paused_since(*scope) is not None,
            }
        )
    return {
        "settings": await openings.get_settings(conn),
        "overrides": await openings.list_overrides(conn),
        "sensors": sensors,
        "paused": [
            {"scope": scope, "scope_id": scope_id, "since": since.isoformat()}
            for (scope, scope_id), since in monitor.paused_items()
        ],
        "fireplace_rooms": [
            {"room_id": room_id, "fireplace": name}
            for room_id, name in sorted(scheduler.fireplaces.set_aside_rooms().items())
        ],
    }


@docs(tags=["smart-control"], summary="Smart Control settings, door and window sensors, and pauses")
@response_schema(schemas.SmartControlSchema)
@routes.get("/api/smart-control")
async def get_smart_control(request: web.Request) -> web.Response:
    return json_response(await _smart_control_snapshot(request))


@docs(tags=["smart-control"], summary="Update house-wide door and window settings")
@request_schema(schemas.SmartControlSettingsSchema)
@response_schema(schemas.SmartControlSchema)
@routes.put("/api/smart-control/settings")
async def update_smart_control_settings(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    try:
        await openings.update_settings(conn, body)
    except UserError as exc:
        return error(safe_text(exc))
    await request.app["scheduler"].refresh_openings()
    await emit(request, "info", "api", "Door and window settings updated", body)
    return json_response(await _smart_control_snapshot(request))


@docs(tags=["smart-control"], summary="Set or clear door and window overrides for a zone or room")
@request_schema(schemas.SmartControlOverrideWriteSchema)
@response_schema(schemas.SmartControlSchema)
@routes.put("/api/smart-control/overrides/{scope}/{scope_id:[^/]+}")
async def update_smart_control_override(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    scope = request.match_info["scope"]
    scope_id = request.match_info["scope_id"]
    try:
        await openings.set_overrides(conn, scope, scope_id, body)
    except UserError as exc:
        return error(safe_text(exc))
    except LookupError:
        return error("Zone or room not found", status=404)
    await request.app["scheduler"].refresh_openings()
    await emit(
        request,
        "info",
        "api",
        "Door and window override updated",
        {"scope": scope, "scope_id": scope_id, **body},
    )
    return json_response(await _smart_control_snapshot(request))


@docs(
    tags=["smart-control"], summary="Put a door or window sensor in a room, and say what it pauses"
)
@request_schema(schemas.ContactSensorWriteSchema)
@response_schema(schemas.SmartControlSchema)
@routes.put("/api/smart-control/contacts/{entity_id:[^/]+}")
async def save_contact_sensor(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    entity_id = request.match_info["entity_id"]
    try:
        await openings.save_contact(
            conn, entity_id, body.get("room_id"), body.get("pauses", "room")
        )
    except UserError as exc:
        return error(safe_text(exc))
    await request.app["scheduler"].refresh_openings()
    await emit(request, "info", "api", f"Door or window sensor saved: {entity_id}", body)
    return json_response(await _smart_control_snapshot(request))


@docs(tags=["smart-control"], summary="Remove a door or window sensor")
@response_schema(schemas.SmartControlSchema)
@routes.delete("/api/smart-control/contacts/{entity_id:[^/]+}")
async def delete_contact_sensor(request: web.Request) -> web.Response:
    conn = await get_conn(request)
    entity_id = request.match_info["entity_id"]
    if not await openings.delete_contact(conn, entity_id):
        return error("Sensor not found", status=404)
    await request.app["scheduler"].refresh_openings()
    await emit(request, "info", "api", f"Door or window sensor removed: {entity_id}", {})
    return json_response(await _smart_control_snapshot(request))


# ---------------------------------------------------------------------------
# Smart Control: shades
# ---------------------------------------------------------------------------


async def _shades_snapshot(request: web.Request) -> dict:
    conn = await get_conn(request)
    ha = request.app["ha"]
    settings = await shades.get_settings(conn)
    sun = shades.Sun.read(
        ha.get_state("sun.sun"),
        ha.get_state(settings["weather_entity"]) if settings["weather_entity"] else None,
    )
    statuses = request.app["scheduler"].shade_controller.status
    out = []
    for s in await shades.list_shades(conn):
        state = ha.get_state(s.entity_id)
        now_open = shades.is_open(state, s)
        status = statuses.get(s.entity_id)
        out.append(
            {
                **s.__dict__,
                "name": ((state or {}).get("attributes") or {}).get("friendly_name") or s.entity_id,
                "state": "unknown"
                if state is None
                else ("moving" if now_open is None else ("open" if now_open else "closed")),
                "reason": status.reason if status else "",
                "last_moved_at": _iso(status.last_moved_at) if status else None,
                "hold_until": _iso(status.hold_until) if status else None,
            }
        )
    return {"settings": settings, "sun": sun.__dict__, "shades": out}


@docs(tags=["shades"], summary="Shade settings, the sun, and each shade with what it is doing")
@response_schema(schemas.ShadesSchema)
@routes.get("/api/shades")
async def get_shades(request: web.Request) -> web.Response:
    return json_response(await _shades_snapshot(request))


@docs(tags=["shades"], summary="Update shade automation settings")
@request_schema(schemas.ShadeSettingsSchema)
@response_schema(schemas.ShadesSchema)
@routes.put("/api/shades/settings")
async def update_shade_settings(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    try:
        await shades.update_settings(conn, body)
    except UserError as exc:
        return error(safe_text(exc))
    await emit(request, "info", "api", "Shade settings updated", body)
    return json_response(await _shades_snapshot(request))


async def _learning_snapshot(request: web.Request) -> dict:
    conn = await get_conn(request)
    return {
        "settings": await learning.get_settings(conn),
        **await learning.status(conn, now=datetime.now(tz.UTC)),
    }


@docs(tags=["learning"], summary="Smart Learning settings and how much each room has collected")
@response_schema(schemas.LearningSchema)
@routes.get("/api/learning")
async def get_learning(request: web.Request) -> web.Response:
    return json_response(await _learning_snapshot(request))


@docs(tags=["learning"], summary="Update Smart Learning settings")
@request_schema(schemas.LearningSettingsSchema)
@response_schema(schemas.LearningSchema)
@routes.put("/api/learning/settings")
async def update_learning_settings(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    try:
        await learning.update_settings(conn, body)
    except UserError as exc:
        return error(safe_text(exc))
    await emit(request, "info", "api", "Smart Learning settings updated", body)
    return json_response(await _learning_snapshot(request))


async def _fireplaces_snapshot(request: web.Request) -> dict:
    scheduler = request.app["scheduler"]
    await scheduler.refresh_fireplaces()
    return {
        "fireplaces": [
            {
                "id": s.fireplace.id,
                "name": s.fireplace.name,
                "entity_id": s.fireplace.entity_id,
                "room_ids": list(s.fireplace.room_ids),
                "cooldown_min": s.fireplace.cooldown_min,
                "control": s.fireplace.control,
                "state": s.state,
                "lit_since": _iso(s.lit_since),
                "cooling_until": _iso(s.cooling_until),
                "setting_aside": s.setting_aside,
            }
            for s in scheduler.fireplaces.statuses()
        ]
    }


@docs(tags=["fireplace"], summary="Fireplaces, the rooms they warm, and whether each is lit")
@response_schema(schemas.FireplacesSchema)
@routes.get("/api/fireplaces")
async def get_fireplaces(request: web.Request) -> web.Response:
    return json_response(await _fireplaces_snapshot(request))


@docs(tags=["fireplace"], summary="Add a fireplace")
@request_schema(schemas.FireplaceWriteSchema)
@response_schema(schemas.FireplacesSchema)
@routes.post("/api/fireplaces")
async def create_fireplace(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    try:
        await fireplace.create(conn, body)
    except UserError as exc:
        return error(safe_text(exc))
    await emit(request, "info", "api", "Fireplace added", body)
    return json_response(await _fireplaces_snapshot(request), status=201)


@docs(tags=["fireplace"], summary="Change a fireplace")
@request_schema(schemas.FireplaceWriteSchema)
@response_schema(schemas.FireplacesSchema)
@routes.put("/api/fireplaces/{fireplace_id}")
async def update_fireplace(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    try:
        found = await fireplace.update(conn, request.match_info["fireplace_id"], body)
    except UserError as exc:
        return error(safe_text(exc))
    if not found:
        return error("Fireplace not found", status=404)
    await emit(request, "info", "api", "Fireplace changed", body)
    return json_response(await _fireplaces_snapshot(request))


@docs(tags=["fireplace"], summary="Remove a fireplace")
@response_schema(schemas.FireplacesSchema)
@routes.delete("/api/fireplaces/{fireplace_id}")
async def delete_fireplace(request: web.Request) -> web.Response:
    conn = await get_conn(request)
    if not await fireplace.delete(conn, request.match_info["fireplace_id"]):
        return error("Fireplace not found", status=404)
    await emit(request, "info", "api", "Fireplace removed", {})
    return json_response(await _fireplaces_snapshot(request))


async def _forecast_snapshot(request: web.Request) -> dict:
    conn = await get_conn(request)
    snap: dict = await request.app["scheduler"].forecast.snapshot(conn, now=datetime.now(tz.UTC))
    return snap


@docs(tags=["forecast"], summary="Forecast settings and the forecast in use")
@response_schema(schemas.ForecastSchema)
@routes.get("/api/forecast")
async def get_forecast(request: web.Request) -> web.Response:
    return json_response(await _forecast_snapshot(request))


@docs(tags=["forecast"], summary="Update forecast settings, then fetch")
@request_schema(schemas.ForecastSettingsSchema)
@response_schema(schemas.ForecastSchema)
@routes.put("/api/forecast/settings")
async def update_forecast_settings(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    try:
        await forecast.update_settings(conn, body)
    except UserError as exc:
        return error(safe_text(exc))
    await emit(request, "info", "api", "Forecast settings updated", body)
    await request.app["scheduler"].refresh_forecast()
    return json_response(await _forecast_snapshot(request))


@docs(tags=["forecast"], summary="Fetch the forecast now")
@response_schema(schemas.ForecastSchema)
@routes.post("/api/forecast/refresh")
async def refresh_forecast(request: web.Request) -> web.Response:
    await request.app["scheduler"].refresh_forecast()
    return json_response(await _forecast_snapshot(request))


@docs(tags=["shades"], summary="Add a shade to a room, or change one")
@request_schema(schemas.ShadeWriteSchema)
@response_schema(schemas.ShadesSchema)
@routes.put("/api/shades/{entity_id:[^/]+}")
async def save_shade(request: web.Request) -> web.Response:
    body = await _json_object(request)
    conn = await get_conn(request)
    entity_id = request.match_info["entity_id"]
    try:
        await shades.save_shade(conn, entity_id, body)
    except UserError as exc:
        return error(safe_text(exc))
    await emit(request, "info", "api", f"Shade saved: {entity_id}", body)
    return json_response(await _shades_snapshot(request))


@docs(tags=["shades"], summary="Remove a shade")
@response_schema(schemas.ShadesSchema)
@routes.delete("/api/shades/{entity_id:[^/]+}")
async def delete_shade(request: web.Request) -> web.Response:
    conn = await get_conn(request)
    entity_id = request.match_info["entity_id"]
    if not await shades.delete_shade(conn, entity_id):
        return error("Shade not found", status=404)
    await emit(request, "info", "api", f"Shade removed: {entity_id}", {})
    return json_response(await _shades_snapshot(request))


# ---------------------------------------------------------------------------
# Metrics: backup heat
# ---------------------------------------------------------------------------


@docs(tags=["metrics"], summary="Backup (aux) heat minutes and episodes for a zone")
@query_params(_DATE_RANGE_QUERY_PARAMS)
@response_schema(schemas.AuxSummarySchema)
@routes.get("/api/metrics/thermostats/{entity_id:[^/]+}/aux")
async def metrics_aux(request: web.Request) -> web.Response:
    conn = await get_conn(request)
    start, end = await _parse_date_range(request)
    zone = tz.get_timezone()
    start_at = datetime.combine(date.fromisoformat(start), time.min, zone)
    end_at = datetime.combine(date.fromisoformat(end) + timedelta(days=1), time.min, zone)
    return json_response(
        await heat_pump.aux_summary(conn, request.match_info["entity_id"], start_at, end_at)
    )
