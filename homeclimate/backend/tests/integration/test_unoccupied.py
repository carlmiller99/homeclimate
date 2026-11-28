"""When Unoccupied: a room's own targets while its occupancy sensors see nobody."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import db, house
from backend.engine import room_manager
from backend.models import PresenceHoldoverState

pytestmark = pytest.mark.asyncio

T1 = "climate.upstairs"


@pytest.fixture
async def room(client, fake_ha):
    fake_ha.seed_state(T1, "heat", {"current_temperature": 70, "hvac_action": "idle"})
    resp = await client.post("/api/rooms", json={"name": "Loft", "thermostat_entity_id": T1})
    rid = (await resp.json())["id"]
    await client.put(
        f"/api/house/targets/room/{rid}", json={"house_heat_to": 69, "house_cool_to": 73}
    )
    return rid


async def _following(client, rid):
    conn = await client.app["scheduler"].get_db()
    found = [ar for ar in await room_manager.get_active_rooms(conn, T1) if ar.room.id == rid]
    return (found[0].source, found[0].heat_to, found[0].cool_to) if found else None


async def _occupied(client, rid):
    conn = await client.app["scheduler"].get_db()
    now = datetime.now(UTC)
    await db.upsert_holdover_state(
        conn,
        PresenceHoldoverState(
            room_id=rid, last_detected_at=now, expires_at=now + timedelta(hours=1)
        ),
    )


async def test_unoccupied_targets_apply_only_while_sensors_see_nobody(client, room):
    resp = await client.put(
        f"/api/house/targets/unoccupied/{room}", json={"house_heat_to": 62, "house_cool_to": 80}
    )
    assert resp.status == 200, await resp.text()
    stored = (await resp.json())["targets"]
    assert {
        "scope": "unoccupied",
        "scope_id": room,
        "house_heat_to": 62.0,
        "house_cool_to": 80.0,
    } in stored
    # No occupancy sensor: nothing can say it is empty, so it keeps its targets.
    assert await _following(client, room) == ("house", 69.0, 73.0)
    await client.post(f"/api/rooms/{room}/presence", json={"entity_id": "binary_sensor.loft"})
    assert await _following(client, room) == ("house", 62.0, 80.0)
    # Occupied with no When Occupied of its own: its targets, not the unoccupied ones.
    await _occupied(client, room)
    assert await _following(client, room) == ("house", 69.0, 73.0)
    # With one, that.
    await client.put(f"/api/rooms/{room}", json={"system_wide_temp": 71})
    assert (await _following(client, room))[0] == "presence"
    # A room that does not follow occupancy never uses them.
    conn = await client.app["scheduler"].get_db()
    await db.delete_holdover_state(conn, room)
    await house.set_switches(conn, room, {"use_presence": False})
    assert await _following(client, room) == ("house", 69.0, 73.0)


async def test_unoccupied_targets_are_checked_like_any_and_go_with_the_room(client, room):
    url = f"/api/house/targets/unoccupied/{room}"
    resp = await client.put(url, json={"house_heat_to": 75, "house_cool_to": 70})
    assert resp.status == 400
    assert (
        await client.put(
            "/api/house/targets/unoccupied/nope", json={"house_heat_to": 60, "house_cool_to": 80}
        )
    ).status == 404
    # Celsius in, °F stored.
    client.app["scheduler"]._active_unit = "C"
    try:
        resp = await client.put(url, json={"house_heat_to": 17, "house_cool_to": 27})
    finally:
        client.app["scheduler"]._active_unit = "F"
    conn = await client.app["scheduler"].get_db()
    assert (await house.load(conn)).levels[("unoccupied", room)] == house.Band(62.6, 80.6)
    assert (await client.delete(f"/api/rooms/{room}")).status in (200, 204)
    assert ("unoccupied", room) not in (await house.load(conn)).levels
