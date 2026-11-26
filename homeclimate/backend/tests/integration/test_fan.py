"""Fan: mixing a zone's rooms while its building holds it to one side."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from backend import db, fan, house

pytestmark = pytest.mark.asyncio

T1 = "climate.main"
NOW = datetime(2026, 1, 5, 18, 0, tzinfo=UTC)


def _room(name, temp, heat_to=70.0, cool_to=72.0, paused=False):
    return fan.RoomNow(name.lower(), name, temp, heat_to, cool_to, paused)


async def test_a_warm_room_is_mixed_with_a_cooler_one():
    rooms = [_room("Loft", 74.0), _room("Den", 71.0), _room("Hall", 73.5)]
    want = fan.decide(rooms, "cooling", running=False)
    assert want == fan.Want("loft", "Loft", ("den",), 2.0, 3.0)
    # The mirror image: a building held to cooling, a room that is too cold.
    rooms = [_room("Loft", 68.0), _room("Den", 71.0)]
    assert fan.decide(rooms, "heating", running=False) == fan.Want(
        "loft", "Loft", ("den",), 2.0, 3.0
    )
    # Of two rooms that qualify, the one further out is the reason.
    rooms = [_room("Loft", 74.0), _room("Attic", 76.0), _room("Den", 71.0)]
    assert fan.decide(rooms, "cooling", running=False).room_id == "attic"


async def test_what_does_not_start_the_fan():
    den = _room("Den", 71.0)
    # Not far enough past its target, or no room far enough from it.
    assert fan.decide([_room("Loft", 72.4), den], "cooling", running=False) is None
    assert fan.decide([_room("Loft", 74.0), _room("Den", 73.0)], "cooling", running=False) is None
    # A paused room is neither a reason nor a help.
    assert fan.decide([_room("Loft", 74.0, paused=True), den], "cooling", running=False) is None
    paused = _room("Den", 71.0, paused=True)
    assert fan.decide([_room("Loft", 74.0), paused], "cooling", running=False) is None
    # No reading, or nothing the room is kept to.
    assert fan.decide([_room("Loft", None), den], "cooling", running=False) is None
    assert fan.decide([_room("Loft", 74.0), _room("Den", None)], "cooling", running=False) is None
    assert fan.decide([_room("Loft", 74.0, cool_to=None), den], "cooling", running=False) is None
    # Too warm is no reason when the fan is working the cold side.
    assert fan.decide([_room("Loft", 74.0), den], "heating", running=False) is None


async def test_a_running_fan_keeps_going_until_the_room_is_back_or_the_rooms_are_close():
    den = _room("Den", 71.0)
    # Less than it takes to start is enough to keep going...
    assert fan.decide([_room("Loft", 72.2), den], "cooling", running=True) is not None
    # ...until the room is back at its target, or the rooms are close together.
    assert fan.decide([_room("Loft", 72.0), den], "cooling", running=True) is None
    assert fan.decide([_room("Loft", 72.5), _room("Den", 72.0)], "cooling", running=True) is None


async def test_with_an_outside_air_intake_the_outside_has_to_help():
    rooms = [_room("Loft", 74.0), _room("Den", 71.0)]
    assert fan.decide(rooms, "cooling", running=False, intake=True, outside=60.0) is not None
    assert fan.decide(rooms, "cooling", running=False, intake=True, outside=80.0) is None
    assert fan.decide(rooms, "cooling", running=False, intake=True, outside=None) is None
    cold = [_room("Loft", 68.0), _room("Den", 71.0)]
    assert fan.decide(cold, "heating", running=False, intake=True, outside=75.0) is not None
    assert fan.decide(cold, "heating", running=False, intake=True, outside=40.0) is None
    # With no intake the outside temperature is not asked about.
    assert fan.decide(rooms, "cooling", running=False, outside=80.0) is not None


def _zone(**over) -> fan.ZoneInput:
    base = {
        "thermostat_entity_id": T1,
        "name": "Main",
        "level": "on",
        "air_intake": "unsure",
        "idle": True,
        "cycle_mode": None,
        "side": "heating",
        "obey": True,
        "rooms": [_room("Loft", 74.0), _room("Den", 71.0)],
        "fan_mode": "auto",
        "supported": True,
    }
    return fan.ZoneInput(**{**base, **over})


class _Run:
    """One manager, with what it said and which rooms' vents it opened."""

    def __init__(self, client, fake_ha) -> None:
        self.client, self.ha = client, fake_ha
        self.manager = fan.Manager()
        self.said: list[str] = []
        self.opened: list[list[str]] = []

    async def tick(self, zone, now=NOW, outside=None) -> str:
        conn = await self.client.app["scheduler"].get_db()

        async def say(message, _details):
            self.said.append(message)

        async def open_vents(room_ids):
            self.opened.append(room_ids)

        zones = [] if zone is None else [zone]
        await self.manager.tick(conn, self.ha, zones, outside, now, say=say, open_vents=open_vents)
        return self.manager.note(T1)

    def modes(self) -> list[str]:
        return [c.data["fan_mode"] for c in self.ha.calls_for("set_fan_mode")]


async def test_the_fan_is_turned_on_and_handed_back(client, fake_ha):
    run = _Run(client, fake_ha)
    note = await run.tick(_zone())
    assert run.modes() == ["on"]
    assert note == "Running: Loft is 2.0° past its target and another room is 3.0° closer to it"
    assert run.opened == [["loft", "den"]]
    assert run.said == [f"Fan running for Main: {note.removeprefix('Running: ')}"]
    assert run.manager.running(T1)
    conn = await client.app["scheduler"].get_db()
    assert json.loads(await db.get_system_setting(conn, fan.RUNNING_SETTING, "")) == [T1]
    # Still wanted a minute later: nothing is sent again.
    await run.tick(_zone(fan_mode="on"), NOW + timedelta(minutes=1))
    assert run.modes() == ["on"]
    # The room is back: the fan goes back to the thermostat.
    back = [_room("Loft", 71.9), _room("Den", 71.0)]
    await run.tick(_zone(fan_mode="on", rooms=back), NOW + timedelta(minutes=12))
    assert run.modes() == ["on", "auto"]
    assert run.said[-1] == "Fan stopped for Main"
    assert not run.manager.running(T1)
    assert run.manager.minutes_used(T1, NOW + timedelta(minutes=12)) == 12
    assert json.loads(await db.get_system_setting(conn, fan.RUNNING_SETTING, "")) == []


async def test_what_keeps_the_fan_off(client, fake_ha):
    run = _Run(client, fake_ha)
    for over, note in (
        ({"level": "off"}, ""),
        ({"blocked": "Vacation Mode is on"}, "Vacation Mode is on"),
        ({"supported": False}, "This thermostat has no fan setting HomeClimate can switch"),
        ({"idle": False, "cycle_mode": "heating"}, ""),
        (
            {"obey": False},
            "Only used while the building holds this zone to heating or to cooling",
        ),
        ({"side": None}, "Only used while the building holds this zone to heating or to cooling"),
        ({"side": "off"}, "Only used while the building holds this zone to heating or to cooling"),
        ({"fan_mode": "on"}, "The fan is already on at the thermostat"),
    ):
        assert await run.tick(_zone(**over)) == note, over
    assert run.modes() == []
    assert not run.manager.running(T1)
    # A fan somebody else turned on is never turned off either.
    await run.tick(_zone(fan_mode="on", rooms=[_room("Loft", 71.0), _room("Den", 71.0)]))
    assert run.modes() == []


async def test_watching_only_says_what_it_would_do_once(client, fake_ha):
    run = _Run(client, fake_ha)
    note = await run.tick(_zone(level="watch"))
    assert note.startswith("Would run: Loft is 2.0° past its target")
    await run.tick(_zone(level="watch"), NOW + timedelta(minutes=1))
    assert run.modes() == [] and len(run.said) == 1
    assert run.said[0].startswith("Fan would run for Main (watching only): Loft")
    # Once the reason has gone, the next one is said again.
    await run.tick(_zone(level="watch", rooms=[_room("Loft", 71.0), _room("Den", 71.0)]))
    await run.tick(_zone(level="watch"), NOW + timedelta(minutes=3))
    assert len(run.said) == 2


async def test_a_cycle_or_a_change_of_level_stops_a_running_fan(client, fake_ha):
    run = _Run(client, fake_ha)
    await run.tick(_zone())
    await run.tick(
        _zone(fan_mode="on", idle=False, cycle_mode="heating"), NOW + timedelta(minutes=2)
    )
    assert run.modes() == ["on", "auto"]
    await run.tick(_zone(), NOW + timedelta(minutes=20))
    await run.tick(_zone(fan_mode="on", level="watch"), NOW + timedelta(minutes=21))
    assert run.modes() == ["on", "auto", "on", "auto"]
    # Changed at the thermostat meanwhile: it is no longer ours, and is left.
    await run.tick(_zone(), NOW + timedelta(minutes=30))
    await run.tick(_zone(fan_mode="auto", level="off"), NOW + timedelta(minutes=31))
    assert run.modes() == ["on", "auto", "on", "auto", "on"]
    assert not run.manager.running(T1)


async def test_no_more_than_half_of_any_hour(client, fake_ha):
    run = _Run(client, fake_ha)
    await run.tick(_zone())
    at = NOW + timedelta(minutes=30)
    assert await run.tick(_zone(fan_mode="on"), at) == "Has run 30 minutes in the last hour"
    assert run.modes() == ["on", "auto"]
    assert await run.tick(_zone(), at + timedelta(minutes=20)) == (
        "Has run 30 minutes in the last hour"
    )
    # An hour after it started, the first minutes have aged out.
    note = await run.tick(_zone(), NOW + timedelta(minutes=62))
    assert note.startswith("Running:")
    assert run.manager.minutes_used(T1, NOW + timedelta(minutes=62)) == 28


async def test_the_fan_waits_after_a_cooling_run(client, fake_ha):
    run = _Run(client, fake_ha)
    cold = [_room("Loft", 68.0), _room("Den", 71.0)]
    cooling = _zone(side="cooling", rooms=cold, idle=False, cycle_mode="cooling")
    await run.tick(cooling)
    idle = _zone(side="cooling", rooms=cold)
    assert await run.tick(idle, NOW + timedelta(minutes=5)) == "Waiting 10 min after cooling"
    assert run.modes() == []
    note = await run.tick(idle, NOW + timedelta(minutes=15))
    assert note.startswith("Running: Loft")


async def test_a_thermostat_that_refuses_is_reported_and_tried_again(client, fake_ha, monkeypatch):
    run = _Run(client, fake_ha)

    async def refuse(*_a, **_k):
        raise RuntimeError("not supported")

    monkeypatch.setattr(fake_ha, "call_service", refuse)
    assert await run.tick(_zone()) == "The thermostat did not accept the fan change"
    assert not run.manager.running(T1)
    monkeypatch.undo()
    await run.tick(_zone(), NOW + timedelta(minutes=1))
    assert run.manager.running(T1)
    # Failing to hand it back keeps it ours, to try again next time.
    monkeypatch.setattr(fake_ha, "call_service", refuse)
    await run.tick(_zone(fan_mode="on", level="off"), NOW + timedelta(minutes=2))
    assert run.manager.running(T1)


async def test_a_fan_left_on_across_a_restart_is_handed_back(client, fake_ha):
    conn = await client.app["scheduler"].get_db()
    await db.set_system_setting(conn, fan.RUNNING_SETTING, json.dumps([T1, "climate.gone", 7]))
    run = _Run(client, fake_ha)
    still = [_room("Loft", 71.0), _room("Den", 71.0)]
    await run.tick(_zone(fan_mode="on", rooms=still))
    assert run.modes() == ["auto"]
    # A zone that is gone is forgotten without a call.
    assert json.loads(await db.get_system_setting(conn, fan.RUNNING_SETTING, "")) == []
    for junk in ("not json", '{"a": 1}'):
        await db.set_system_setting(conn, fan.RUNNING_SETTING, junk)
        fresh = _Run(client, fake_ha)
        await fresh.tick(None)
        assert not fresh.manager.running(T1)


async def test_the_intake_test_reports_a_hint(client, fake_ha):
    run = _Run(client, fake_ha)
    rooms = [_room("Loft", 70.0), _room("Den", 72.0)]
    await run.manager.start_test(fake_ha, _zone(rooms=rooms), 40.0, NOW)
    assert run.modes() == ["on"] and run.manager.testing(T1)
    assert await run.tick(_zone(fan_mode="on", rooms=rooms), NOW + timedelta(minutes=4)) == (
        "Testing for an outside air intake"
    )
    cooler = [_room("Loft", 69.2), _room("Den", 71.4)]
    await run.tick(_zone(fan_mode="on", rooms=cooler), NOW + timedelta(minutes=10))
    assert run.modes() == ["on", "auto"] and not run.manager.testing(T1)
    conn = await client.app["scheduler"].get_db()
    result = await fan.last_test(conn, T1)
    assert (result["difference"], result["moved"], result["hint"]) == (31.0, 0.7, "possible")
    assert result["interrupted"] is False
    assert run.said[-1] == "Fan test finished for Main"

    # Rooms that did not move toward a warm outside: no sign of an intake.
    await run.manager.start_test(fake_ha, _zone(rooms=rooms), 95.0, NOW)
    await run.tick(_zone(fan_mode="on", rooms=cooler), NOW + timedelta(minutes=10))
    assert (await fan.last_test(conn, T1))["hint"] == "none"

    # A cycle that starts ends the test, and the fan somebody had on is left on.
    await run.manager.start_test(fake_ha, _zone(rooms=rooms, fan_mode="on"), 40.0, NOW)
    calls = len(run.modes())
    await run.tick(
        _zone(fan_mode="on", idle=False, cycle_mode="heating"), NOW + timedelta(minutes=2)
    )
    assert (await fan.last_test(conn, T1)) == {
        "at": (NOW + timedelta(minutes=2)).isoformat(),
        "interrupted": True,
    }
    assert len(run.modes()) == calls
    assert await fan.last_test(conn, "climate.never") is None
    await db.set_system_setting(conn, fan.TEST_SETTING + T1, "[1]")
    assert await fan.last_test(conn, T1) is None


async def test_when_the_intake_test_cannot_run(client, fake_ha, monkeypatch):
    manager = fan.Manager()
    rooms = [_room("Loft", 70.0), _room("Den", 72.0)]
    for zone, outside, message in (
        (None, 40.0, fan.ZONE_UNKNOWN),
        (_zone(supported=False), 40.0, fan.NO_FAN_SETTING),
        (_zone(blocked="The system is off"), 40.0, fan.TEST_BLOCKED),
        (_zone(idle=False), 40.0, fan.TEST_BUSY),
        (_zone(rooms=rooms), None, fan.TEST_NO_OUTSIDE),
        (_zone(rooms=[_room("Loft", None)]), 40.0, fan.TEST_NO_OUTSIDE),
        (_zone(rooms=rooms), 65.0, fan.TEST_TOO_CLOSE),
    ):
        with pytest.raises(fan.FanError) as raised:
            await manager.start_test(fake_ha, zone, outside, NOW)
        assert str(raised.value) == message

    async def refuse(*_a, **_k):
        raise RuntimeError("not supported")

    monkeypatch.setattr(fake_ha, "call_service", refuse)
    with pytest.raises(fan.FanError) as raised:
        await manager.start_test(fake_ha, _zone(rooms=rooms), 40.0, NOW)
    assert str(raised.value) == fan.FAN_FAILED
    monkeypatch.undo()
    await manager.start_test(fake_ha, _zone(rooms=rooms), 40.0, NOW)
    with pytest.raises(fan.FanError) as raised:
        await manager.start_test(fake_ha, _zone(rooms=rooms), 40.0, NOW)
    assert str(raised.value) == fan.TEST_RUNNING


OUTDOOR = "sensor.outdoor"
FAN_ATTRS = {
    "current_temperature": 71,
    "hvac_action": "idle",
    "fan_mode": "auto",
    "fan_modes": ["on", "auto"],
}


@pytest.fixture
async def home(client, fake_ha):
    """One zone with two rooms, held to heating by its building."""
    fake_ha.seed_state(T1, "heat", dict(FAN_ATTRS))
    fake_ha.seed_state(OUTDOOR, "40", {"unit_of_measurement": "°F"})
    await client.put("/api/settings/outside-temp-entity", json={"entity_id": OUTDOOR})
    rooms = {}
    for name, temp in (("Loft", "75.0"), ("Den", "71.0")):
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": T1})
        assert resp.status == 201, await resp.text()
        rooms[name] = (await resp.json())["id"]
        sensor = f"sensor.{name.lower()}"
        fake_ha.seed_state(sensor, temp, {"unit_of_measurement": "°F"})
        await client.post(f"/api/rooms/{rooms[name]}/sensors", json={"entity_id": sensor})
        fake_ha.seed_state(f"cover.{name.lower()}", "closed")
        await client.post(
            f"/api/rooms/{rooms[name]}/vents",
            json={"entity_id": f"cover.{name.lower()}", "control_method": "open_close"},
        )
    main = (await (await client.post("/api/buildings", json={"name": "Main House"})).json())["id"]
    assert (await client.put(f"/api/zones/{T1}", json={"building_id": main})).status == 200
    assert (
        await client.put(f"/api/building-modes/{main}", json={"mode": "heat_only"})
    ).status == 200
    conn = await client.app["scheduler"].get_db()
    await house.set_level(conn, "building", main, 70, 72)
    return rooms


async def _fan(client) -> dict:
    zones: list[dict] = (await (await client.get("/api/fan")).json())["zones"]
    return zones[0]


async def test_the_scheduler_runs_the_fan_for_a_held_zone(client, fake_ha, home, tick):
    # Off until it is turned on.
    await tick()
    assert fake_ha.calls_for("set_fan_mode") == []
    resp = await client.put(f"/api/zones/{T1}", json={"fan_level": "on", "air_intake": "no"})
    assert resp.status == 200, await resp.text()
    assert ((await resp.json())["fan_level"], (await resp.json())["air_intake"]) == ("on", "no")
    await tick()
    assert [c.data for c in fake_ha.calls_for("set_fan_mode")] == [
        {"entity_id": T1, "fan_mode": "on"}
    ]
    assert {c.data["entity_id"] for c in fake_ha.calls_for("open_cover")} >= {
        "cover.loft",
        "cover.den",
    }
    got = await _fan(client)
    assert (got["level"], got["air_intake"], got["supported"]) == ("on", "no", True)
    assert got["running"] and got["note"].startswith("Running: Loft is 3.0° past its target")
    assert (got["testing"], got["test"]) == (False, None)
    # Vacation Mode stops it.
    fake_ha.seed_state(T1, "heat", {**FAN_ATTRS, "fan_mode": "on"})
    client.app["scheduler"]._vacation_mode = True
    await tick()
    assert fake_ha.calls_for("set_fan_mode")[-1].data["fan_mode"] == "auto"
    assert (await _fan(client))["note"] == "Vacation Mode is on"


async def test_what_the_scheduler_tells_the_fan(client, fake_ha, home):
    scheduler = client.app["scheduler"]
    zone = (await scheduler.fan_zones())[0]
    assert (zone.side, zone.obey, zone.idle, zone.supported, zone.blocked) == (
        "heating",
        True,
        True,
        True,
        "",
    )
    assert [(r.name, r.temp, r.heat_to, r.cool_to, r.paused) for r in zone.rooms] == [
        ("Den", 71.0, 70.0, 72.0, False),
        ("Loft", 75.0, 70.0, 72.0, False),
    ]
    # A room with a single target is kept to it on both sides; one not in use
    # is left out; one following nothing can still help.
    await client.post(
        f"/api/rooms/{home['Loft']}/override", json={"target_temp": 69, "duration_hours": 2}
    )
    await client.put(f"/api/house/rooms/{home['Den']}", json={"in_use": False})
    zone = (await scheduler.fan_zones())[0]
    assert [(r.name, r.heat_to, r.cool_to) for r in zone.rooms] == [("Loft", 69.0, 69.0)]
    # A thermostat with no fan setting, one that is cooling, the system off.
    fake_ha.seed_state(T1, "cool", {"current_temperature": 71, "hvac_action": "cooling"})
    zone = (await scheduler.fan_zones())[0]
    assert (zone.supported, zone.idle, zone.cycle_mode, zone.fan_mode) == (
        False,
        False,
        "cooling",
        None,
    )
    scheduler._system_enabled = False
    assert (await scheduler.fan_zones())[0].blocked == "The system is off"


async def test_an_open_door_or_a_lit_fireplace_keeps_the_fan_off(
    client, fake_ha, home, monkeypatch
):
    scheduler = client.app["scheduler"]
    monkeypatch.setattr(
        scheduler._openings, "pause_for", lambda _tid: (False, frozenset({home["Den"]}))
    )
    zone = (await scheduler.fan_zones())[0]
    assert [(r.name, r.paused) for r in zone.rooms] == [("Den", True), ("Loft", False)]
    assert zone.blocked == ""
    monkeypatch.setattr(scheduler._openings, "pause_for", lambda _tid: (True, frozenset()))
    assert (await scheduler.fan_zones())[0].blocked == "A door or window is open"
    monkeypatch.undo()
    monkeypatch.setattr(scheduler._fireplaces, "set_aside_rooms", lambda: {home["Den"]: "fp"})
    assert (await scheduler.fan_zones())[0].blocked == "A fireplace is lit"


async def test_the_fan_settings_are_checked(client, home):
    for body in ({"fan_level": "high"}, {"air_intake": "maybe"}):
        resp = await client.put(f"/api/zones/{T1}", json=body)
        assert resp.status == 400, body


async def test_the_intake_test_through_the_api(client, fake_ha, home, tick):
    resp = await client.post("/api/fan/climate.nope/test")
    assert (resp.status, (await resp.json())["error"]) == (404, fan.ZONE_UNKNOWN)
    fake_ha.seed_state(OUTDOOR, "68", {"unit_of_measurement": "°F"})
    resp = await client.post(f"/api/fan/{T1}/test")
    assert (resp.status, (await resp.json())["error"]) == (400, fan.TEST_TOO_CLOSE)
    fake_ha.seed_state(OUTDOOR, "40", {"unit_of_measurement": "°F"})
    resp = await client.post(f"/api/fan/{T1}/test")
    assert resp.status == 200, await resp.text()
    body = await resp.json()
    assert body["test_minutes"] == 10 and body["zones"][0]["testing"] is True
    assert fake_ha.calls_for("set_fan_mode")[-1].data == {"entity_id": T1, "fan_mode": "on"}
    # While it runs, the ordinary fan rules are not applied to the zone.
    await client.put(f"/api/zones/{T1}", json={"fan_level": "on"})
    await tick()
    assert (await _fan(client))["note"] == "Testing for an outside air intake"
    assert len(fake_ha.calls_for("set_fan_mode")) == 1


async def test_a_failure_in_the_fan_never_stops_the_tick(client, home, tick, monkeypatch, caplog):
    async def _boom():
        raise RuntimeError("database is locked")

    monkeypatch.setattr(client.app["scheduler"], "fan_zones", _boom)
    await tick()
    assert "Could not run the fans" in caplog.text
