"""A band (heat-to and cool-to) on a schedule, an occupancy target or a hold."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import db, house
from backend.engine import room_manager
from backend.models import PresenceHoldoverState, RoomOverride

pytestmark = pytest.mark.asyncio

T1 = "climate.main"
ALL_DAY = {"days_of_week": list(range(7)), "start_time": "00:00", "end_time": "23:59"}


@pytest.fixture
async def room(client, fake_ha):
    fake_ha.seed_state(T1, "heat", {"current_temperature": 70, "hvac_action": "idle"})
    resp = await client.post("/api/rooms", json={"name": "Bunk Room", "thermostat_entity_id": T1})
    assert resp.status == 201, await resp.text()
    return (await resp.json())["id"]


async def _following(client) -> tuple:
    conn = await client.app["scheduler"].get_db()
    (ar,) = await room_manager.get_active_rooms(conn, T1)
    return ar.source, ar.target_temp, ar.heat_to, ar.cool_to


async def _celsius(client, on: bool):
    client.app["scheduler"]._active_unit = "C" if on else "F"


async def test_a_schedule_can_have_a_band_or_a_single_target(client, room):
    url = f"/api/rooms/{room}/schedules"
    resp = await client.post(url, json={**ALL_DAY, "target_temp": 68})
    single = await resp.json()
    assert (resp.status, single["cool_to"]) == (201, None)
    assert await _following(client) == ("schedule", 68.0, None, None)

    resp = await client.put(f"{url}/{single['id']}", json={"cool_to": 74})
    assert (resp.status, (await resp.json())["cool_to"]) == (200, 74.0)
    assert await _following(client) == ("schedule", 68.0, 68.0, 74.0)
    assert (await (await client.get(url)).json())[0]["cool_to"] == 74.0
    got = await (await client.get(f"/api/rooms/{room}")).json()
    assert got["schedules"][0]["cool_to"] == 74.0

    # Moving the target keeps the band, as long as it is still one.
    resp = await client.put(f"{url}/{single['id']}", json={"target_temp": 70})
    assert (resp.status, (await resp.json())["cool_to"]) == (200, 74.0)
    assert await _following(client) == ("schedule", 70.0, 70.0, 74.0)
    # A move that would leave less than 3 °F drops the band rather than refuse the
    # change: a client that knows nothing of bands must still be able to move a target.
    resp = await client.put(f"{url}/{single['id']}", json={"target_temp": 72})
    assert (resp.status, (await resp.json())["cool_to"]) == (200, None)
    assert await _following(client) == ("schedule", 72.0, None, None)
    await client.put(f"{url}/{single['id']}", json={"target_temp": 70, "cool_to": 74})
    # A change that leaves the target alone does not re-check anything.
    assert (await client.put(f"{url}/{single['id']}", json={"name": "Day"})).status == 200
    assert await _following(client) == ("schedule", 70.0, 70.0, 74.0)

    # null makes it a single target again; deleting the block removes its band.
    resp = await client.put(f"{url}/{single['id']}", json={"cool_to": None})
    assert (await resp.json())["cool_to"] is None
    assert await _following(client) == ("schedule", 70.0, None, None)
    await client.put(f"{url}/{single['id']}", json={"cool_to": 75})
    await client.delete(f"{url}/{single['id']}")
    conn = await client.app["scheduler"].get_db()
    assert (await house.load(conn)).targets == {}


async def test_a_band_is_created_with_the_block_and_converted_once(client, room):
    await _celsius(client, True)
    try:
        resp = await client.post(
            f"/api/rooms/{room}/schedules", json={**ALL_DAY, "target_temp": 20, "cool_to": 24}
        )
        made = await resp.json()
    finally:
        await _celsius(client, False)
    assert resp.status == 201, made
    assert (made["target_temp"], made["cool_to"]) == (68.0, 75.2)
    assert await _following(client) == ("schedule", 68.0, 68.0, 75.2)


async def test_what_a_band_must_be(client, room):
    url = f"/api/rooms/{room}/schedules"
    for cool, message in (
        (
            70,
            "cool_to and its target must be between 45.0 and 95.0°F,"
            " with cool_to at least 3.0° above the target",
        ),
        (
            96,
            "cool_to and its target must be between 45.0 and 95.0°F,"
            " with cool_to at least 3.0° above the target",
        ),
        ("warm", "cool_to must be a number or null"),
        (True, "cool_to must be a number or null"),
    ):
        resp = await client.post(url, json={**ALL_DAY, "target_temp": 68, "cool_to": cool})
        assert (resp.status, (await resp.json())["error"]) == (400, message)
    assert await (await client.get(url)).json() == []  # nothing was half-made

    # Inside every zone's safety limits, like the house band.
    await client.put(f"/api/thermostats/{T1}", json={"min_setpoint": 60, "max_setpoint": 72})
    resp = await client.post(url, json={**ALL_DAY, "target_temp": 68, "cool_to": 80})
    assert resp.status == 201
    resp = await client.post(f"/api/rooms/{room}/override", json={"target_temp": 72, "cool_to": 76})
    assert resp.status == 400
    assert (await resp.json())["error"] == (
        "The band must sit inside every zone's safety limits: the target at most"
        " 71.0°F and cool_to at least 61.0°F"
    )
    await _celsius(client, True)
    try:
        resp = await client.post(
            f"/api/rooms/{room}/override", json={"target_temp": 20, "cool_to": 21}
        )
    finally:
        await _celsius(client, False)
    assert (
        "between 7.3 and 35.0°C, with cool_to at least 1.7° above" in (await resp.json())["error"]
    )


async def test_a_hold_can_be_a_band_and_only_for_that_hold(client, room):
    resp = await client.post(f"/api/rooms/{room}/override", json={"target_temp": 66, "cool_to": 72})
    assert (resp.status, (await resp.json())["cool_to"]) == (200, 72.0)
    assert await _following(client) == ("override", 66.0, 66.0, 72.0)
    assert (await (await client.get("/api/overrides")).json())[0]["cool_to"] == 72.0
    events = await (await client.get("/api/logs/events?category=api")).json()
    assert any("66.0°F to 72.0°F" in e["message"] for e in events)

    # A later hold set some other way (MQTT, an automation) is not given the old band,
    # even at the same temperature.
    conn = await client.app["scheduler"].get_db()
    later = datetime.now(UTC) + timedelta(hours=3)
    await db.set_room_override(conn, RoomOverride(room, 66.0, later))
    assert await _following(client) == ("override", 66.0, None, None)
    assert (await (await client.get("/api/overrides")).json())[0]["cool_to"] is None

    # A new hold without cool_to clears what was there.
    resp = await client.post(f"/api/rooms/{room}/override", json={"target_temp": 66})
    assert (await resp.json())["cool_to"] is None
    assert (await house.load(conn)).targets == {}


async def test_an_occupancy_target_can_be_a_band(client, room):
    url = f"/api/rooms/{room}"
    resp = await client.put(url, json={"presence_cool_to": 74})
    assert (resp.status, (await resp.json())["error"]) == (
        400,
        "presence_cool_to needs a target to pair with",
    )
    resp = await client.put(url, json={"system_wide_temp": 68, "presence_cool_to": 74})
    assert (resp.status, (await resp.json())["presence_cool_to"]) == (200, 74.0)
    assert (await (await client.get(url)).json())["presence_cool_to"] == 74.0
    assert (await (await client.get("/api/rooms")).json())[0]["presence_cool_to"] == 74.0

    conn = await client.app["scheduler"].get_db()
    now = datetime.now(UTC)
    await db.upsert_holdover_state(
        conn,
        PresenceHoldoverState(
            room_id=room, last_detected_at=now, expires_at=now + timedelta(hours=1)
        ),
    )
    assert await _following(client) == ("presence", 68.0, 68.0, 74.0)

    # The band follows the target when only the target is changed…
    resp = await client.put(url, json={"system_wide_temp": 70})
    assert (await resp.json())["presence_cool_to"] == 74.0
    assert await _following(client) == ("presence", 70.0, 70.0, 74.0)
    resp = await client.put(url, json={"system_wide_temp": 73})
    assert (resp.status, (await resp.json())["presence_cool_to"]) == (200, None)
    await client.put(url, json={"system_wide_temp": 70, "presence_cool_to": 74})
    # …is untouched by an unrelated change, and goes when the target does.
    assert (await (await client.put(url, json={"notes": "x"})).json())["presence_cool_to"] == 74.0
    resp = await client.put(url, json={"presence_cool_to": None})
    assert (await resp.json())["presence_cool_to"] is None
    await client.put(url, json={"presence_cool_to": 75})
    resp = await client.put(url, json={"system_wide_temp": None})
    assert (await resp.json())["presence_cool_to"] is None
    assert (await (await client.get(url)).json())["presence_cool_to"] is None
    assert (await house.load(conn)).targets == {}


async def test_the_dashboard_status_shows_the_band(client, room):
    await client.post(
        f"/api/rooms/{room}/schedules", json={**ALL_DAY, "target_temp": 68, "cool_to": 74}
    )
    resp = await client.post("/api/rooms/active-status", json={"room_ids": [room]})
    status = (await resp.json())[room]
    assert (status["source"], status["target_temp"], status["heat_to"], status["cool_to"]) == (
        "schedule",
        68.0,  # still there, as the heat-to, for readers that know nothing of bands
        68.0,
        74.0,
    )


async def test_copying_a_block_copies_its_band(client, room, fake_ha):
    other = (
        await (
            await client.post("/api/rooms", json={"name": "Craft Room", "thermostat_entity_id": T1})
        ).json()
    )["id"]
    made = await (
        await client.post(
            f"/api/rooms/{room}/schedules", json={**ALL_DAY, "target_temp": 68, "cool_to": 76}
        )
    ).json()
    plain = await (
        await client.post(
            f"/api/rooms/{other}/schedules",
            json={
                "days_of_week": [0],
                "start_time": "01:00",
                "end_time": "02:00",
                "target_temp": 70,
            },
        )
    ).json()
    resp = await client.post(
        f"/api/rooms/{room}/schedules/{made['id']}/copy", json={"target_room_ids": [other]}
    )
    assert resp.status == 200, await resp.text()
    copies = {s["id"]: s for s in await (await client.get(f"/api/rooms/{other}/schedules")).json()}
    copied = copies[(await resp.json())[0]["schedule_id"]]
    assert (copied["target_temp"], copied["cool_to"]) == (68.0, 76.0)
    # A single-target block copies as one.
    resp = await client.post(
        f"/api/rooms/{other}/schedules/{plain['id']}/copy", json={"target_room_ids": [room]}
    )
    back = (await resp.json())[0]["schedule_id"]
    mine = {s["id"]: s for s in await (await client.get(f"/api/rooms/{room}/schedules")).json()}
    assert mine[back]["cool_to"] is None
    resp = await client.post(
        f"/api/rooms/{room}/schedules/nope/copy", json={"target_room_ids": [other]}
    )
    assert resp.status == 404


async def test_a_band_left_behind_by_another_writer_is_never_revived(client, room):
    url = f"/api/rooms/{room}/schedules"
    made = await (await client.post(url, json={**ALL_DAY, "target_temp": 68, "cool_to": 76})).json()
    conn = await client.app["scheduler"].get_db()
    # Something that knows nothing of bands moves the target straight in the database.
    (block,) = await db.get_schedules_for_room(conn, room)
    block.target_temp = 72.0
    await db.upsert_schedule(conn, block)
    assert (await (await client.get(url)).json())[0]["cool_to"] is None
    # A later unrelated edit must not bring the old cool-to back onto the new target.
    resp = await client.put(f"{url}/{made['id']}", json={"name": "Day"})
    assert (await resp.json())["cool_to"] is None
    assert await _following(client) == ("schedule", 72.0, None, None)
    assert (await house.load(conn)).targets == {}

    # The same for a room's occupancy target.
    room_url = f"/api/rooms/{room}"
    await client.put(room_url, json={"system_wide_temp": 68, "presence_cool_to": 74})
    stored = await db.get_room(conn, room)
    stored.system_wide_temp = 71.0
    await db.upsert_room(conn, stored)
    resp = await client.put(room_url, json={"notes": "x"})
    assert (await resp.json())["presence_cool_to"] is None


async def test_a_refused_band_changes_nothing_else(client, room, fake_ha):
    fake_ha.seed_state("climate.new", "heat", {"current_temperature": 70})
    # A second room, so that moving this one does not empty its zone.
    await client.post("/api/rooms", json={"name": "Craft Room", "thermostat_entity_id": T1})
    resp = await client.put(
        f"/api/rooms/{room}",
        json={
            "thermostat_entity_id": "climate.new",
            "system_wide_temp": 68,
            "presence_cool_to": 69,
        },
    )
    assert resp.status == 400
    zones = await (await client.get("/api/zones")).json()
    assert "climate.new" not in [z["thermostat_entity_id"] for z in zones]


async def test_bands_go_when_what_they_belong_to_goes(client, room):
    conn = await client.app["scheduler"].get_db()
    await client.post(
        f"/api/rooms/{room}/schedules", json={**ALL_DAY, "target_temp": 68, "cool_to": 76}
    )
    await client.put(f"/api/rooms/{room}", json={"system_wide_temp": 68, "presence_cool_to": 74})
    await client.post(f"/api/rooms/{room}/override", json={"target_temp": 66, "cool_to": 72})
    assert len((await house.load(conn)).targets) == 3
    await client.delete(f"/api/rooms/{room}/override")
    assert ("hold", room) not in (await house.load(conn)).targets
    # Every writer goes through the same deletes, not only the HTTP handlers.
    (block,) = await db.get_schedules_for_room(conn, room)
    await db.delete_schedule(conn, block.id)
    assert ("schedule", block.id) not in (await house.load(conn)).targets
    await client.post(
        f"/api/rooms/{room}/schedules", json={**ALL_DAY, "target_temp": 68, "cool_to": 76}
    )
    await db.delete_room(conn, room)
    assert (await house.load(conn)).targets == {}


async def test_the_zones_default_occupancy_target_is_never_a_band(client, room):
    conn = await client.app["scheduler"].get_db()
    await client.put(f"/api/rooms/{room}", json={"system_wide_temp": 68, "presence_cool_to": 74})
    stored = await db.get_room(conn, room)
    stored.system_wide_temp = None
    await db.upsert_room(conn, stored)
    await client.put(f"/api/thermostats/{T1}", json={"default_temp": 68})
    now = datetime.now(UTC)
    await db.upsert_holdover_state(
        conn,
        PresenceHoldoverState(
            room_id=room, last_detected_at=now, expires_at=now + timedelta(hours=1)
        ),
    )
    assert await _following(client) == ("presence", 68.0, None, None)
