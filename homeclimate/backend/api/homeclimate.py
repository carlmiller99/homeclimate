"""HomeClimate REST endpoints: buildings and zones.

Registered on the shared ``routes`` table, so they get OpenAPI docs, the auth
and CSRF middleware, MCP tools and the API-spec enforcement test for free.
"""

from __future__ import annotations

import logging

from aiohttp import web

from .. import db, ha_import, zones
from . import schemas
from .openapi import docs, request_schema, response_schema
from .routes import emit, error, get_conn, json_response, refresh, routes

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
        return error(str(exc))
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
        return error(str(exc))
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
    return json_response([zones.as_dict(z) for z in await zones.list_zone_profiles(conn)])


@docs(tags=["zones"], summary="Update a zone's building, order or equipment profile")
@request_schema(schemas.ZoneProfileWriteSchema)
@response_schema(schemas.ZoneProfileSchema)
@routes.put("/api/zones/{entity_id:[^/]+}")
async def update_zone(request: web.Request) -> web.Response:
    body = await _json_object(request)
    entity_id = request.match_info["entity_id"]
    conn = await get_conn(request)
    try:
        zone = await zones.update_zone_profile(conn, entity_id, body)
    except zones.ZoneError as exc:
        return error(str(exc))
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
    except (ha_import.ImportError_, zones.ZoneError) as exc:
        return error(str(exc))
    await refresh(request)
    await emit(
        request, "info", "api", "Imported zones and rooms from Home Assistant", result.as_dict()
    )
    return json_response(result.as_dict())
