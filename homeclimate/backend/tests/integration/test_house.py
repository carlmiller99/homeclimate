"""The house band and the per-room switches for what a room follows."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta

import pytest

from backend import db, house
from backend.engine import room_manager
from backend.models import PresenceHoldoverState, RoomOverride, Schedule

pytestmark = pytest.mark.asyncio

T1 = "climate.main"


@pytest.fixture
async def rooms(client, fake_ha):
    fake_ha.seed_state(T1, "heat", {"current_temperature": 70, "hvac_action": "idle"})
    out = {}
    for name in ("Bunk Room", "Craft Room"):
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": T1})
        assert resp.status == 201, await resp.text()
        out[name.split()[0].lower()] = (await resp.json())["id"]
    return out


async def _sources(client) -> dict[str, tuple]:
    conn = await client.app["scheduler"].get_db()
    return {
        ar.room.name: (ar.source, ar.heat_to, ar.cool_to)
        for ar in await room_manager.get_active_rooms(conn, T1)
    }


async def _set(client, heat, cool):
    return await client.put("/api/house", json={"house_heat_to": heat, "house_cool_to": cool})


async def test_with_no_house_band_nothing_changes(client, rooms):
    snap = await (await client.get("/api/house")).json()
    assert (snap["house_heat_to"], snap["house_cool_to"]) == (None, None)
    assert (snap["min_gap"], snap["low"], snap["high"]) == (3.0, 45.0, 95.0)
    assert snap["rooms"] == [
        {"room_id": rooms["bunk"], "in_use": True, "use_schedules": True, "use_presence": True},
        {"room_id": rooms["craft"], "in_use": True, "use_schedules": True, "use_presence": True},
    ]
    assert await _sources(client) == {}


async def test_every_room_follows_the_house_band(client, rooms):
    snap = await (await _set(client, 68, 74)).json()
    assert (snap["house_heat_to"], snap["house_cool_to"]) == (68.0, 74.0)
    assert await _sources(client) == {
        "Bunk Room": ("house", 68.0, 74.0),
        "Craft Room": ("house", 68.0, 74.0),
    }
    status = await (
        await client.post("/api/rooms/active-status", json={"room_ids": [rooms["bunk"]]})
    ).json()
    one = status[rooms["bunk"]]
    assert (one["source"], one["target_temp"], one["heat_to"], one["cool_to"]) == (
        "house",
        None,
        68.0,
        74.0,
    )
    # Clearing it returns every room to asking for nothing.
    snap = await (await _set(client, None, None)).json()
    assert snap["house_heat_to"] is None
    assert await _sources(client) == {}


async def test_a_hold_a_schedule_or_occupancy_gives_a_room_its_own_target(client, rooms):
    await _set(client, 68, 74)
    conn = await client.app["scheduler"].get_db()
    now = datetime.now(UTC)
    await db.upsert_schedule(
        conn,
        Schedule(
            id="s1",
            room_id=rooms["bunk"],
            days_of_week=[0, 1, 2, 3, 4, 5, 6],
            start_time=time(0, 0),
            end_time=time(23, 59),
            target_temp=71.0,
        ),
    )
    await db.upsert_holdover_state(
        conn,
        PresenceHoldoverState(
            room_id=rooms["craft"], last_detected_at=now, expires_at=now + timedelta(hours=1)
        ),
    )
    await client.put(f"/api/rooms/{rooms['craft']}", json={"system_wide_temp": 72})
    assert await _sources(client) == {
        "Bunk Room": ("schedule", None, None),
        "Craft Room": ("presence", None, None),
    }

    # Each can be switched off for a room, which puts it back on the house band.
    resp = await client.put(f"/api/house/rooms/{rooms['bunk']}", json={"use_schedules": False})
    assert (await resp.json())["rooms"][0]["use_schedules"] is False
    await client.put(f"/api/house/rooms/{rooms['craft']}", json={"use_presence": False})
    assert await _sources(client) == {
        "Bunk Room": ("house", 68.0, 74.0),
        "Craft Room": ("house", 68.0, 74.0),
    }
    # The schedule was skipped, not deleted.
    assert len(await db.get_schedules_for_room(conn, rooms["bunk"])) == 1
    await client.put(f"/api/house/rooms/{rooms['bunk']}", json={"use_schedules": True})
    assert (await _sources(client))["Bunk Room"][0] == "schedule"

    # A hold always wins.
    await db.set_room_override(
        conn,
        RoomOverride(room_id=rooms["craft"], target_temp=66.0, expires_at=now + timedelta(hours=1)),
    )
    assert (await _sources(client))["Craft Room"][0] == "override"


async def test_a_room_not_in_use_follows_nothing_but_a_hold(client, rooms):
    await _set(client, 68, 74)
    conn = await client.app["scheduler"].get_db()
    now = datetime.now(UTC)
    await db.upsert_schedule(
        conn,
        Schedule(
            id="s1",
            room_id=rooms["bunk"],
            days_of_week=[0, 1, 2, 3, 4, 5, 6],
            start_time=time(0, 0),
            end_time=time(23, 59),
            target_temp=71.0,
        ),
    )
    await client.put(f"/api/house/rooms/{rooms['bunk']}", json={"in_use": False})
    assert await _sources(client) == {"Craft Room": ("house", 68.0, 74.0)}
    await db.set_room_override(
        conn,
        RoomOverride(room_id=rooms["bunk"], target_temp=66.0, expires_at=now + timedelta(hours=1)),
    )
    assert (await _sources(client))["Bunk Room"][0] == "override"
    # Deleting the room clears its switches.
    await client.post("/api/rooms", json={"name": "Spare", "thermostat_entity_id": T1})
    await client.delete(f"/api/rooms/{rooms['bunk']}")
    assert rooms["bunk"] not in (await house.load(conn)).rooms


async def test_the_band_is_validated_and_converted(client, rooms):
    both = "Send both house_heat_to and house_cool_to: two numbers, or two nulls"
    numbers = "house_heat_to and house_cool_to must be numbers"
    span = "Heat-to and cool-to must be between 45.0 and 95.0°F, at least 3.0° apart"
    for body, message in (
        ({"house_heat_to": 68, "house_cool_to": None}, both),
        ({"house_heat_to": None, "house_cool_to": 74}, both),
        ({"house_heat_to": 68}, both),
        ({}, both),  # an empty body must not clear the band
        ({"house_heat_to": "68", "house_cool_to": 74}, numbers),
        ({"house_heat_to": 68, "house_cool_to": True}, numbers),
        ({"house_heat_to": 68, "house_cool_to": 10**400}, numbers),
        ({"house_heat_to": 72, "house_cool_to": 74}, span),
        ({"house_heat_to": 40, "house_cool_to": 74}, span),
        ({"house_heat_to": 68, "house_cool_to": 99}, span),
    ):
        resp = await client.put("/api/house", json=body)
        assert resp.status == 400, body
        assert (await resp.json())["error"] == message
    resp = await client.put("/api/house", json={"house_heat_to": 68, "nope": 1})
    assert (await resp.json())["error"] == "Unknown house setting"
    assert (await _set(client, 71, 74)).status == 200  # exactly the minimum gap

    scheduler = client.app["scheduler"]
    scheduler._active_unit = "C"
    try:
        snap = await (await _set(client, 20, 24)).json()
        assert (snap["house_heat_to"], snap["house_cool_to"]) == (68.0, 75.2)  # always °F out
        resp = await _set(client, 20, 21)
        # The bounds named are ones that would be accepted.
        assert (await resp.json())["error"] == (
            "Heat-to and cool-to must be between 7.3 and 35.0°C, at least 1.7° apart"
        )
        assert (await _set(client, 7.3, 35)).status == 200
    finally:
        scheduler._active_unit = "F"


async def test_the_band_must_sit_inside_every_zones_safety_limits(client, rooms):
    """Heating toward 88 with the setpoint capped at 85 could never finish."""
    resp = await client.post(
        "/api/thermostats",
        json={
            "thermostat_entity_id": T1,
            "name": "Main",
            "min_setpoint": 60,
            "max_setpoint": 85,
            "total_vents_count": 4,
        },
    )
    assert resp.status in (200, 201), await resp.text()
    message = (
        "The band must sit inside every zone's safety limits: Heat To at most 84.0°F"
        " and Cool To at least 61.0°F"
    )
    for heat, cool in ((88, 95), (45, 50), (84.5, 90)):
        resp = await _set(client, heat, cool)
        assert (resp.status, (await resp.json())["error"]) == (400, message), (heat, cool)
    assert (await _set(client, 84, 95)).status == 200
    assert (await _set(client, 45, 61)).status == 200


async def test_what_a_room_reports_matches_its_switches(client, rooms):
    conn = await client.app["scheduler"].get_db()
    now = datetime.now(UTC)
    later = (now + timedelta(hours=2)).astimezone().time().replace(microsecond=0)
    await db.upsert_schedule(
        conn,
        Schedule(
            id="s1",
            room_id=rooms["bunk"],
            days_of_week=[0, 1, 2, 3, 4, 5, 6],
            start_time=later,
            end_time=time(23, 59),
            target_temp=71.0,
        ),
    )
    await db.upsert_holdover_state(
        conn,
        PresenceHoldoverState(
            room_id=rooms["bunk"], last_detected_at=now, expires_at=now + timedelta(hours=1)
        ),
    )

    async def status() -> dict:
        got = await (
            await client.post("/api/rooms/active-status", json={"room_ids": [rooms["bunk"]]})
        ).json()
        found: dict = got[rooms["bunk"]]
        return found

    assert (await status())["presence_holdover_active"] is True
    await client.put(f"/api/house/rooms/{rooms['bunk']}", json={"use_presence": False})
    assert (await status())["presence_holdover_active"] is False
    await client.put(
        f"/api/house/rooms/{rooms['bunk']}", json={"use_presence": True, "use_schedules": False}
    )
    one = await status()
    assert one["presence_holdover_active"] is True
    assert one["next_schedule_in_seconds"] is None and one["next_schedule_label"] is None
    await client.put(f"/api/house/rooms/{rooms['bunk']}", json={"in_use": False})
    assert (await status())["presence_holdover_active"] is False
    events = await (await client.get("/api/logs/events?category=api")).json()
    assert "What Bunk Room follows changed" in [e["message"] for e in events]


async def test_room_switches_are_validated(client, rooms):
    url = f"/api/house/rooms/{rooms['bunk']}"
    resp = await client.put(url, json={"in_use": "no"})
    assert (resp.status, (await resp.json())["error"]) == (
        400,
        "Room switches must be true or false",
    )
    resp = await client.put(url, json={"asleep": True})
    assert (resp.status, (await resp.json())["error"]) == (400, "Unknown room switch")
    resp = await client.put("/api/house/rooms/nope", json={"in_use": False})
    assert (resp.status, (await resp.json())["error"]) == (404, "Room not found")


async def test_a_stored_band_that_is_unreadable_is_no_band(client, rooms):
    conn = await client.app["scheduler"].get_db()
    for stored in ("warm,74", "68", "74,68", "68,69", "68,74,80"):
        await db.set_system_setting(conn, "house_band", stored)
        assert (await house.load(conn)).band is None, stored
    await db.set_system_setting(conn, "house_band", "68.00,74.00")
    assert (await house.load(conn)).band == house.Band(68.0, 74.0)


async def test_a_change_that_cannot_be_applied_at_once_still_saves(
    client, rooms, monkeypatch, caplog
):
    async def boom():
        raise RuntimeError("engine busy")

    monkeypatch.setattr(client.app["scheduler"], "tick_all_now", boom)
    assert (await _set(client, 68, 74)).status == 200
    assert "Could not apply the change straight away" in caplog.text


@pytest.mark.filterwarnings("ignore::pytest.PytestWarning")
def test_the_target_a_band_gives_the_engine():
    band = house.Band(68.0, 74.0)
    assert band.target_for("heating", 80.0) == 68.0
    assert band.target_for("cooling", 60.0) == 74.0
    assert band.target_for(None, 60.0) == 68.0  # below: short of heat-to
    assert band.target_for(None, 80.0) == 74.0  # above: short of cool-to
    assert band.target_for(None, 71.3) == 71.3  # inside: at target
    assert band.target_for("off", None) == 68.0
