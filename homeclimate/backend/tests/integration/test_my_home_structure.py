"""My Home structure: rooms always have a zone, and zones keep a room."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio

T1 = "climate.upstairs"
T2 = "climate.wing"


async def _room(client, name: str, thermostat: str):
    return await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": thermostat})


async def test_a_room_registers_its_zone_and_rejects_a_bad_one(client):
    resp = await _room(client, "Bunk Room", T1)
    assert resp.status == 201
    zones = [z["thermostat_entity_id"] for z in await (await client.get("/api/thermostats")).json()]
    assert zones == [T1]
    events = await (await client.get("/api/logs/events?category=api")).json()
    messages = [e["message"] for e in (events["events"] if isinstance(events, dict) else events)]
    assert f"Zone registered for a new room: {T1}" in messages

    bad = await client.post("/api/rooms", json={"name": "Den", "thermostat_entity_id": 5})
    assert bad.status == 400
    assert (await bad.json())["error"] == "Choose a zone for the room."
    for junk in ("", "not_a_climate", "sensor.kitchen", "climate."):
        bad = await client.post("/api/rooms", json={"name": "Den", "thermostat_entity_id": junk})
        assert bad.status == 400, junk
    assert zones == [
        z["thermostat_entity_id"] for z in await (await client.get("/api/thermostats")).json()
    ]


async def test_a_rejected_room_leaves_no_empty_zone_behind(client):
    assert (await _room(client, "Den", T1)).status == 201
    # Same name once sanitised: refused, and the zone it named is not created.
    clash = await _room(client, "den", T2)
    assert clash.status == 400
    zones = [z["thermostat_entity_id"] for z in await (await client.get("/api/thermostats")).json()]
    assert zones == [T1]
    # Refused for another reason (a temperature out of range), same outcome.
    bad = await client.post(
        "/api/rooms",
        json={"name": "Attic", "thermostat_entity_id": T2, "temp_offset": 500},
    )
    assert bad.status == 400
    zones = [z["thermostat_entity_id"] for z in await (await client.get("/api/thermostats")).json()]
    assert zones == [T1]


async def test_moving_rooms_between_zones(client):
    bunk = (await (await _room(client, "Bunk Room", T1)).json())["id"]
    craft = (await (await _room(client, "Craft Room", T1)).json())["id"]

    bad = await client.put(f"/api/rooms/{bunk}", json={"thermostat_entity_id": ["x"]})
    assert bad.status == 400
    # Moving one of two rooms is fine, and registers the new zone.
    for junk in ("not_a_climate", "", "climate."):
        bad = await client.put(f"/api/rooms/{bunk}", json={"thermostat_entity_id": junk})
        assert bad.status == 400, junk
    # A move that is refused for another reason registers nothing.
    refused = await client.put(
        f"/api/rooms/{bunk}", json={"thermostat_entity_id": T2, "temp_offset": 500}
    )
    assert refused.status == 400
    zones = [z["thermostat_entity_id"] for z in await (await client.get("/api/thermostats")).json()]
    assert zones == [T1]
    moved = await client.put(f"/api/rooms/{bunk}", json={"thermostat_entity_id": T2})
    assert moved.status == 200, await moved.text()
    zones = {z["thermostat_entity_id"] for z in await (await client.get("/api/thermostats")).json()}
    assert zones == {T1, T2}
    events = await (await client.get("/api/logs/events?category=api")).json()
    messages = [e["message"] for e in (events["events"] if isinstance(events, dict) else events)]
    assert f"Zone registered for a new room: {T2}" in messages
    # Craft Room is now Upstairs' last room: it can't leave or be deleted.
    last = await client.put(f"/api/rooms/{craft}", json={"thermostat_entity_id": T2})
    assert last.status == 409
    assert (await last.json())["error"].startswith("A zone needs at least one room.")
    assert (await client.delete(f"/api/rooms/{craft}")).status == 409
    # Renaming the last room is not a move.
    assert (await client.put(f"/api/rooms/{craft}", json={"name": "Studio"})).status == 200


async def test_deleting_a_zone_takes_its_rooms_only_when_asked(client):
    room = (await (await _room(client, "Bunk Room", T1)).json())["id"]
    refused = await client.delete(f"/api/thermostats/{T1}")
    assert refused.status == 409
    assert "still has rooms" in (await refused.json())["error"]
    assert (await client.delete(f"/api/thermostats/{T1}?with_rooms=false")).status == 409
    assert (await client.delete(f"/api/thermostats/{T1}?with_rooms=True")).status == 200
    assert (await client.get(f"/api/rooms/{room}")).status == 404
    # A zone with no rooms deletes without the flag.
    await client.post(
        "/api/thermostats",
        json={"thermostat_entity_id": T2, "name": "Wing", "total_vents_count": 2},
    )
    assert (await client.delete(f"/api/thermostats/{T2}")).status == 200


async def test_rooms_from_before_zones_were_required_delete_freely(client):
    from backend import db
    from backend.models import Room

    conn = await client.app["scheduler"].get_db()
    legacy = Room.create(name="Old Room", thermostat_entity_id="climate.unregistered")
    await db.upsert_room(conn, legacy)
    assert (await client.delete(f"/api/rooms/{legacy.id}")).status == 200
