"""Door and window pausing: settings, overrides, sensors and the monitor."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from backend import openings
from backend.user_errors import GENERIC, UserError, safe_text

pytestmark = pytest.mark.asyncio

T1 = "climate.upstairs"
T2 = "climate.wing"
FRONT = "binary_sensor.front_door"
PORCH = "binary_sensor.porch_door"
WINDOW = "binary_sensor.bunk_window"
T0 = datetime(2026, 1, 5, 12, 0, tzinfo=UTC)


def at(minutes: float) -> datetime:
    return T0 + timedelta(minutes=minutes)


async def _thermostat(client, entity_id: str, name: str) -> None:
    resp = await client.post(
        "/api/thermostats",
        json={"thermostat_entity_id": entity_id, "name": name, "total_vents_count": 4},
    )
    assert resp.status in (200, 201), await resp.text()


async def _room(client, name: str, thermostat: str) -> str:
    resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": thermostat})
    assert resp.status in (200, 201), await resp.text()
    return str((await resp.json())["id"])


@pytest.fixture
async def house(client, fake_ha):
    await _thermostat(client, T1, "Upstairs")
    await _thermostat(client, T2, "North Wing")
    bunk = await _room(client, "Bunk Room", T1)
    craft = await _room(client, "Craft Room", T1)
    den = await _room(client, "Den", T2)
    for eid, name in ((FRONT, "Front Door"), (PORCH, "Porch Door"), (WINDOW, "Bunk Window")):
        fake_ha.seed_state(eid, "off", {"friendly_name": name, "device_class": "door"})
    return {"bunk": bunk, "craft": craft, "den": den}


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


async def test_settings_defaults_and_updates(client):
    snap = await (await client.get("/api/smart-control")).json()
    assert snap == {
        "settings": {
            "zone_pause_enabled": True,
            "zone_pause_min": 3,
            "room_pause_enabled": True,
            "room_pause_min": 5,
            "resume_min": 2,
        },
        "overrides": [],
        "sensors": [],
        "paused": [],
        "fireplace_rooms": [],
    }
    resp = await client.put(
        "/api/smart-control/settings",
        json={"zone_pause_enabled": False, "zone_pause_min": 10, "resume_min": 0},
    )
    assert resp.status == 200
    settings = (await resp.json())["settings"]
    assert settings["zone_pause_enabled"] is False
    assert settings["zone_pause_min"] == 10
    assert settings["resume_min"] == 0


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"zone_pause_min": 0}, "zone_pause_min must be a whole number of minutes from 1 to 60"),
        ({"zone_pause_min": 2.5}, "zone_pause_min must be a whole number of minutes from 1 to 60"),
        ({"resume_min": True}, "resume_min must be a whole number of minutes from 0 to 30"),
        ({"resume_min": "2"}, "resume_min must be a whole number of minutes from 0 to 30"),
        ({"room_pause_enabled": 1}, "room_pause_enabled must be true or false"),
        ({"bogus": 1}, "Unknown Smart Control setting"),
    ],
)
async def test_settings_validation(client, body, message):
    resp = await client.put("/api/smart-control/settings", json=body)
    assert resp.status == 400
    assert (await resp.json())["error"] == message


async def test_stored_garbage_falls_back_to_defaults(client):
    conn = await client.app["scheduler"].get_db()
    from backend import db

    await db.set_system_setting(conn, "openings_zone_pause_min", "abc")
    await db.set_system_setting(conn, "openings_room_pause_min", "500")
    await db.set_system_setting(conn, "openings_zone_pause_enabled", "maybe")
    settings = await openings.get_settings(conn)
    assert settings["zone_pause_min"] == 3
    assert settings["room_pause_min"] == 5
    assert settings["zone_pause_enabled"] is True


async def test_overrides(client, house):
    resp = await client.put(
        f"/api/smart-control/overrides/zone/{T1}", json={"zone_pause_min": 1, "resume_min": 4}
    )
    assert resp.status == 200
    resp = await client.put(
        f"/api/smart-control/overrides/room/{house['bunk']}", json={"room_pause_enabled": False}
    )
    overrides = (await resp.json())["overrides"]
    assert {(o["scope"], o["key"], o["value"]) for o in overrides} == {
        ("zone", "zone_pause_min", 1),
        ("zone", "resume_min", 4),
        ("room", "room_pause_enabled", False),
    }
    resp = await client.put(f"/api/smart-control/overrides/zone/{T1}", json={"resume_min": None})
    keys = {o["key"] for o in (await resp.json())["overrides"] if o["scope"] == "zone"}
    assert keys == {"zone_pause_min"}

    bad_key = await client.put(
        f"/api/smart-control/overrides/zone/{T1}", json={"room_pause_min": 2}
    )
    assert bad_key.status == 400
    assert (await bad_key.json())["error"] == (
        "Only zone_pause_enabled, zone_pause_min, resume_min can be overridden for a zone"
    )
    bad_value = await client.put(
        f"/api/smart-control/overrides/room/{house['bunk']}", json={"room_pause_min": 99}
    )
    assert bad_value.status == 400
    bad_scope = await client.put("/api/smart-control/overrides/house/x", json={})
    assert (await bad_scope.json())["error"] == "Scope must be zone or room"
    assert (
        await client.put("/api/smart-control/overrides/zone/climate.none", json={})
    ).status == 404
    assert (await client.put("/api/smart-control/overrides/room/nope", json={})).status == 404


async def test_contact_sensors(client, fake_ha, house):
    resp = await client.put(
        f"/api/smart-control/contacts/{FRONT}", json={"room_id": house["craft"], "pauses": "zone"}
    )
    assert resp.status == 200
    resp = await client.put(
        f"/api/smart-control/contacts/{WINDOW}", json={"room_id": house["bunk"]}
    )
    sensors = {s["entity_id"]: s for s in (await resp.json())["sensors"]}
    assert sensors[FRONT] == {
        "entity_id": FRONT,
        "name": "Front Door",
        "thermostat_entity_id": T1,
        "room_id": house["craft"],
        "pauses": "zone",
        "state": "closed",
        "open_since": None,
        "pausing": False,
    }
    assert (sensors[WINDOW]["room_id"], sensors[WINDOW]["pauses"]) == (house["bunk"], "room")

    # Move the front door to another room, pausing just that room.
    resp = await client.put(
        f"/api/smart-control/contacts/{FRONT}", json={"room_id": house["den"], "pauses": "room"}
    )
    moved = {s["entity_id"]: s for s in (await resp.json())["sensors"]}[FRONT]
    assert (moved["thermostat_entity_id"], moved["room_id"], moved["pauses"]) == (
        T2,
        house["den"],
        "room",
    )

    # An unknown entity has no friendly name and reads offline.
    resp = await client.put(
        "/api/smart-control/contacts/binary_sensor.gone", json={"room_id": house["den"]}
    )
    gone = {s["entity_id"]: s for s in (await resp.json())["sensors"]}["binary_sensor.gone"]
    assert (gone["name"], gone["state"]) == ("binary_sensor.gone", "offline")

    for path, body, message in [
        ("sensor.front", {"room_id": house["bunk"]}, "Choose a door or window binary_sensor"),
        (PORCH, {}, "That room does not exist"),
        (PORCH, {"room_id": "nope"}, "That room does not exist"),
        (PORCH, {"room_id": 7}, "That room does not exist"),
        (PORCH, {"room_id": house["bunk"], "pauses": "house"}, "pauses must be room or zone"),
    ]:
        resp = await client.put(f"/api/smart-control/contacts/{path}", json=body)
        assert resp.status == 400, body
        assert (await resp.json())["error"] == message

    assert (await client.delete(f"/api/smart-control/contacts/{FRONT}")).status == 200
    assert (await client.delete(f"/api/smart-control/contacts/{FRONT}")).status == 404

    # Removing the room removes its sensor.
    assert (await client.delete(f"/api/rooms/{house['bunk']}")).status in (200, 204)
    sensors = (await (await client.get("/api/smart-control")).json())["sensors"]
    assert [s["entity_id"] for s in sensors] == ["binary_sensor.gone"]


async def test_legacy_zone_rows_still_pause_their_zone(client, fake_ha, house):
    conn = await client.app["scheduler"].get_db()
    await conn.execute(
        "INSERT INTO contact_sensors(entity_id, thermostat_entity_id) VALUES(?,?)", (FRONT, T1)
    )
    await conn.commit()
    [legacy] = await openings.list_contacts(conn)
    assert (legacy.room_id, legacy.pauses) == (None, "zone")
    snap = await (await client.get("/api/smart-control")).json()
    assert snap["sensors"][0]["thermostat_entity_id"] == T1
    mon = openings.OpeningMonitor()
    await mon.evaluate(conn, fake_ha.get_state, at(0))
    mon.observe(FRONT, _state("on"), at(0))
    [t] = await mon.evaluate(conn, fake_ha.get_state, at(3))
    assert (t.scope, t.scope_id) == ("zone", T1)


async def test_zone_attached_sensors_move_into_a_room_at_start(client, house):
    conn = await client.app["scheduler"].get_db()
    await conn.execute(
        "INSERT INTO contact_sensors(entity_id, thermostat_entity_id) VALUES(?,?)", (FRONT, T1)
    )
    # A zone with no room: its sensor has nowhere to go and stays as it is.
    await conn.execute(
        "INSERT INTO thermostat_configs(thermostat_entity_id) VALUES('climate.empty')"
    )
    await conn.execute(
        "INSERT INTO contact_sensors(entity_id, thermostat_entity_id) VALUES(?,?)",
        (PORCH, "climate.empty"),
    )
    await conn.commit()

    assert await openings.adopt_zone_contacts(conn) == 1
    by_id = {c.entity_id: c for c in await openings.list_contacts(conn)}
    # Bunk Room sorts before Craft Room; the sensor still pauses the whole zone.
    front = by_id[FRONT]
    assert (front.thermostat_entity_id, front.room_id, front.pauses) == (
        None,
        house["bunk"],
        "zone",
    )
    porch = by_id[PORCH]
    assert (porch.thermostat_entity_id, porch.room_id, porch.pauses) == (
        "climate.empty",
        None,
        "zone",
    )
    # Running it again changes nothing.
    assert await openings.adopt_zone_contacts(conn) == 0


async def test_start_up_moves_zone_attached_sensors_and_logs_it(client, house):
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    await conn.execute(
        "INSERT INTO contact_sensors(entity_id, thermostat_entity_id) VALUES(?,?)", (FRONT, T1)
    )
    await conn.commit()
    await scheduler.adopt_zone_contacts()
    [sensor] = [
        s
        for s in (await (await client.get("/api/smart-control")).json())["sensors"]
        if s["entity_id"] == FRONT
    ]
    assert (sensor["room_id"], sensor["pauses"]) == (house["bunk"], "zone")
    events = await (await client.get("/api/logs/events?category=openings")).json()
    messages = [e["message"] for e in (events["events"] if isinstance(events, dict) else events)]
    assert "Moved 1 door or window sensor(s) from their zone into a room" in messages
    # Nothing left to move: nothing more is logged.
    await scheduler.adopt_zone_contacts()
    events = await (await client.get("/api/logs/events?category=openings")).json()
    again = [e["message"] for e in (events["events"] if isinstance(events, dict) else events)]
    assert again.count("Moved 1 door or window sensor(s) from their zone into a room") == 1


async def test_body_must_be_a_json_object(client):
    resp = await client.put("/api/smart-control/settings", json=[1])
    assert resp.status == 400


# ---------------------------------------------------------------------------
# Monitor
# ---------------------------------------------------------------------------


async def _attach(client, entity_id: str, **target: str) -> None:
    resp = await client.put(f"/api/smart-control/contacts/{entity_id}", json=target)
    assert resp.status == 200


def _state(value: str) -> dict:
    return {"state": value}


async def test_zone_pause_lifecycle(client, fake_ha, house):
    await _attach(client, FRONT, room_id=house["craft"], pauses="zone")
    conn = await client.app["scheduler"].get_db()
    mon = openings.OpeningMonitor()
    get = fake_ha.get_state

    assert await mon.evaluate(conn, get, at(0)) == []
    assert mon.entities == frozenset({FRONT})
    mon.observe(FRONT, _state("on"), at(0))
    assert mon.open_since(FRONT) == at(0)
    assert await mon.evaluate(conn, get, at(2.9)) == []
    assert mon.pause_for(T1) == (False, frozenset())

    [t] = await mon.evaluate(conn, get, at(3))
    assert (t.scope, t.scope_id, t.name, t.paused, t.sensors) == (
        "zone",
        T1,
        "Upstairs",
        True,
        [FRONT],
    )
    assert mon.pause_for(T1) == (True, frozenset())
    assert mon.pause_for(T2) == (False, frozenset())
    assert mon.paused_items() == [(("zone", T1), at(3))]
    # Still open: no repeat transition.
    assert await mon.evaluate(conn, get, at(4)) == []

    # Closes; reopens briefly before the resume delay ends — stays paused.
    mon.observe(FRONT, _state("off"), at(5))
    assert await mon.evaluate(conn, get, at(5)) == []
    mon.observe(FRONT, _state("on"), at(6))
    assert await mon.evaluate(conn, get, at(6)) == []
    mon.observe(FRONT, _state("off"), at(6.5))
    assert await mon.evaluate(conn, get, at(6.5)) == []
    assert await mon.evaluate(conn, get, at(8)) == []
    [t] = await mon.evaluate(conn, get, at(8.5))
    assert (t.paused, t.name) == (False, "Upstairs")
    assert mon.pause_for(T1) == (False, frozenset())


async def test_only_closed_to_open_starts_the_timer(client, fake_ha, house):
    fake_ha.seed_state(FRONT, "on", {"friendly_name": "Front Door"})
    await _attach(client, FRONT, room_id=house["craft"], pauses="zone")
    conn = await client.app["scheduler"].get_db()
    mon = openings.OpeningMonitor()

    # Already open on first sight: no timer.
    await mon.evaluate(conn, fake_ha.get_state, at(0))
    assert mon.state_of(FRONT) == "open"
    assert mon.open_since(FRONT) is None
    assert await mon.evaluate(conn, fake_ha.get_state, at(30)) == []

    # Offline -> open does not start a timer either.
    mon.observe(FRONT, _state("unavailable"), at(31))
    mon.observe(FRONT, _state("on"), at(32))
    assert mon.open_since(FRONT) is None
    # Attribute-only update while open keeps no timer; a real closed->open does.
    mon.observe(FRONT, _state("off"), at(33))
    mon.observe(FRONT, _state("on"), at(34))
    mon.observe(FRONT, _state("on"), at(35))
    assert mon.open_since(FRONT) == at(34)


async def test_nothing_is_seeded_before_home_assistant_reports(client, fake_ha, house):
    await _attach(client, "binary_sensor.not_loaded", room_id=house["craft"], pauses="zone")
    conn = await client.app["scheduler"].get_db()
    mon = openings.OpeningMonitor()
    await mon.evaluate(conn, fake_ha.get_state, at(0))
    assert mon.state_of("binary_sensor.not_loaded") is None
    fake_ha.seed_state("binary_sensor.not_loaded", "off")
    await mon.evaluate(conn, fake_ha.get_state, at(1))
    assert mon.state_of("binary_sensor.not_loaded") == "closed"
    mon.observe("binary_sensor.not_loaded", _state("on"), at(2))
    assert mon.open_since("binary_sensor.not_loaded") == at(2)


async def test_offline_releases_the_pause(client, fake_ha, house):
    await _attach(client, FRONT, room_id=house["craft"], pauses="zone")
    conn = await client.app["scheduler"].get_db()
    await client.put("/api/smart-control/settings", json={"resume_min": 0})
    mon = openings.OpeningMonitor()
    await mon.evaluate(conn, fake_ha.get_state, at(0))
    mon.observe(FRONT, _state("on"), at(0))
    assert [t.paused for t in await mon.evaluate(conn, fake_ha.get_state, at(3))] == [True]
    mon.observe(FRONT, None, at(4))
    assert mon.state_of(FRONT) == "offline"
    assert [t.paused for t in await mon.evaluate(conn, fake_ha.get_state, at(4))] == [False]


async def test_room_pause_and_override_resolution(client, fake_ha, house):
    await _attach(client, WINDOW, room_id=house["bunk"])
    await _attach(client, PORCH, room_id=house["craft"])
    await client.put(f"/api/smart-control/overrides/zone/{T1}", json={"resume_min": 0})
    await client.put(
        f"/api/smart-control/overrides/room/{house['craft']}",
        json={"room_pause_min": 1, "resume_min": 10},
    )
    conn = await client.app["scheduler"].get_db()
    mon = openings.OpeningMonitor()
    await mon.evaluate(conn, fake_ha.get_state, at(0))
    mon.observe(WINDOW, _state("on"), at(0))
    mon.observe(PORCH, _state("on"), at(0))

    # Craft Room's 1 min override fires first; Bunk Room uses the 5 min default.
    [t] = await mon.evaluate(conn, fake_ha.get_state, at(1))
    assert (t.scope, t.name) == ("room", "Craft Room")
    [t] = await mon.evaluate(conn, fake_ha.get_state, at(5))
    assert t.name == "Bunk Room"
    assert mon.pause_for(T1) == (False, frozenset({house["bunk"], house["craft"]}))

    # Bunk Room resumes at once (its zone's resume override is 0); Craft Room
    # waits for its own 10 minutes.
    mon.observe(WINDOW, _state("off"), at(6))
    mon.observe(PORCH, _state("off"), at(6))
    [t] = await mon.evaluate(conn, fake_ha.get_state, at(6))
    assert (t.name, t.paused) == ("Bunk Room", False)
    assert await mon.evaluate(conn, fake_ha.get_state, at(15)) == []
    [t] = await mon.evaluate(conn, fake_ha.get_state, at(16))
    assert (t.name, t.paused) == ("Craft Room", False)

    eff = openings.resolve_settings(
        await openings.get_settings(conn),
        await openings.list_overrides(conn),
        "room",
        house["bunk"],
        None,
    )
    assert eff == openings.ScopeSettings(enabled=True, delay_min=5, resume_min=2)


async def test_disabling_or_removing_releases(client, fake_ha, house):
    await _attach(client, FRONT, room_id=house["craft"], pauses="zone")
    await _attach(client, PORCH, room_id=house["den"], pauses="zone")
    conn = await client.app["scheduler"].get_db()
    mon = openings.OpeningMonitor()
    await mon.evaluate(conn, fake_ha.get_state, at(0))
    mon.observe(FRONT, _state("on"), at(0))
    mon.observe(PORCH, _state("on"), at(0))
    assert len(await mon.evaluate(conn, fake_ha.get_state, at(3))) == 2

    # Turning the zone rule off releases immediately, even with the door open.
    await client.put(f"/api/smart-control/overrides/zone/{T1}", json={"zone_pause_enabled": False})
    [t] = await mon.evaluate(conn, fake_ha.get_state, at(4))
    assert (t.scope_id, t.paused) == (T1, False)

    # Removing the only sensor of a paused zone resumes after the delay; the
    # zone's name falls back to its entity id once the thermostat is gone too.
    await client.delete(f"/api/smart-control/contacts/{PORCH}")
    await client.delete(f"/api/thermostats/{T2}?with_rooms=true")
    assert await mon.evaluate(conn, fake_ha.get_state, at(4)) == []
    [t] = await mon.evaluate(conn, fake_ha.get_state, at(6))
    assert (t.scope_id, t.name, t.paused) == (T2, T2, False)


async def test_removed_room_name_falls_back_to_its_id(client, fake_ha, house):
    await _attach(client, WINDOW, room_id=house["bunk"])
    conn = await client.app["scheduler"].get_db()
    mon = openings.OpeningMonitor()
    await mon.evaluate(conn, fake_ha.get_state, at(0))
    mon.observe(WINDOW, _state("on"), at(0))
    await mon.evaluate(conn, fake_ha.get_state, at(5))
    await client.delete(f"/api/rooms/{house['bunk']}")
    assert await mon.evaluate(conn, fake_ha.get_state, at(5)) == []
    [t] = await mon.evaluate(conn, fake_ha.get_state, at(7))
    assert (t.name, t.paused) == (house["bunk"], False)


# ---------------------------------------------------------------------------
# Scheduler wiring
# ---------------------------------------------------------------------------


async def test_state_change_pauses_logs_and_kicks_the_engine(client, fake_ha, house, tick):
    scheduler = client.app["scheduler"]
    await client.put("/api/smart-control/settings", json={"zone_pause_min": 1})
    await _attach(client, FRONT, room_id=house["craft"], pauses="zone")
    await _attach(client, WINDOW, room_id=house["bunk"])
    await tick()
    assert FRONT in scheduler.openings.entities

    # Backdate the timers so the very next evaluation pauses both scopes.
    await fake_ha.set_entity_state(FRONT, "on", {"friendly_name": "Front Door"})
    await fake_ha.set_entity_state(WINDOW, "on", {})
    mon = scheduler.openings
    mon._opened_at[FRONT] = datetime.now(UTC) - timedelta(minutes=2)
    mon._opened_at[WINDOW] = datetime.now(UTC) - timedelta(minutes=10)
    kicked = AsyncMock()
    scheduler._tick_engine = kicked
    await fake_ha.set_entity_state(PORCH, "on", {})  # not watched: ignored
    await fake_ha.set_entity_state(FRONT, "on", {"friendly_name": "Front Door"})
    assert {c.args[0] for c in kicked.await_args_list} == {T1}
    assert mon.pause_for(T1) == (True, frozenset({house["bunk"]}))

    snap = await (await client.get("/api/smart-control")).json()
    pausing = {s["entity_id"]: s["pausing"] for s in snap["sensors"]}
    assert pausing == {FRONT: True, WINDOW: True}
    assert {(p["scope"], p["scope_id"]) for p in snap["paused"]} == {
        ("zone", T1),
        ("room", house["bunk"]),
    }

    events = await (await client.get("/api/logs/events?category=openings")).json()
    messages = [e["message"] for e in (events["events"] if isinstance(events, dict) else events)]
    assert "Zone Upstairs paused: Front Door open" in messages
    assert f"Room Bunk Room paused: {WINDOW} open" in messages


async def test_resume_is_logged_and_deleted_rooms_touch_no_zone(client, fake_ha, house):
    scheduler = client.app["scheduler"]
    await client.put("/api/smart-control/settings", json={"resume_min": 0})
    await _attach(client, FRONT, room_id=house["craft"], pauses="zone")
    await _attach(client, WINDOW, room_id=house["bunk"])
    mon = scheduler.openings
    await scheduler._evaluate_openings()
    past = datetime.now(UTC) - timedelta(minutes=10)
    mon.observe(FRONT, _state("off"), past)
    mon.observe(FRONT, _state("on"), past)
    mon.observe(WINDOW, _state("off"), past)
    mon.observe(WINDOW, _state("on"), past)
    assert await scheduler._evaluate_openings() == {T1}
    await client.delete(f"/api/rooms/{house['bunk']}")
    mon.observe(FRONT, _state("off"), datetime.now(UTC))
    # The zone resumes; the deleted room's pause clears without naming a zone.
    assert await scheduler._evaluate_openings() == {T1}
    events = await (await client.get("/api/logs/events?category=openings")).json()
    messages = [e["message"] for e in (events["events"] if isinstance(events, dict) else events)]
    assert "Zone Upstairs resumed: doors and windows closed" in messages
    assert f"Room {house['bunk']} resumed: doors and windows closed" in messages


async def test_evaluation_failure_is_logged_not_raised(client, monkeypatch):
    scheduler = client.app["scheduler"]

    async def boom(*_a, **_k):
        raise RuntimeError("db gone")

    monkeypatch.setattr(scheduler.openings, "evaluate", boom)
    assert await scheduler._evaluate_openings() == set()


async def test_transitions_without_a_logger(client, fake_ha, house):
    scheduler = client.app["scheduler"]
    await _attach(client, FRONT, room_id=house["craft"], pauses="zone")
    scheduler._event_logger = None
    mon = scheduler.openings
    await scheduler._evaluate_openings()
    mon.observe(FRONT, _state("on"), datetime.now(UTC) - timedelta(minutes=5))
    assert await scheduler._evaluate_openings() == {T1}


async def test_safe_text_only_returns_registered_messages():
    assert safe_text(UserError("not registered")) == GENERIC
    assert safe_text(UserError()) == GENERIC
    assert safe_text(openings.OpeningsError(openings.BAD_SCOPE)) == openings.BAD_SCOPE
