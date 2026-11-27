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


async def test_only_the_room_the_fan_runs_for_keeps_it_going():
    """Another room's ordinary overshoot must not hold the fan to its limit."""
    den = _room("Den", 68.0, heat_to=None, cool_to=None)
    loft = _room("Loft", 70.3, heat_to=70.0, cool_to=70.0)
    attic = _room("Attic", 70.0, heat_to=70.0, cool_to=70.0)
    rooms = [attic, loft, den]
    # Started for Attic, which is back; Loft is out by too little to start.
    assert fan.decide(rooms, "cooling", running=True, for_room="attic") is None
    assert fan.decide(rooms, "cooling", running=True, for_room="loft") is not None
    # A room far enough out to start takes it over.
    far = [attic, _room("Loft", 73.0, heat_to=70.0, cool_to=70.0), den]
    assert fan.decide(far, "cooling", running=True, for_room="attic").room_id == "loft"


async def test_a_room_past_its_own_target_is_no_help():
    # Den is cooler than Loft, but already above its own cooling target:
    # mixing would push it further out.
    rooms = [_room("Loft", 74.0), _room("Den", 71.0, cool_to=70.0)]
    assert fan.decide(rooms, "cooling", running=False) is None
    cold = [_room("Loft", 68.0), _room("Den", 71.0, heat_to=72.0)]
    assert fan.decide(cold, "heating", running=False) is None
    # One that follows nothing has no target to be past.
    free = [_room("Loft", 74.0), _room("Den", 71.0, heat_to=None, cool_to=None)]
    assert fan.decide(free, "cooling", running=False) is not None
    assert fan.decide([_room("Loft", 68.0), free[1]], "heating", running=False) is not None


async def test_a_room_kept_to_one_number_has_to_be_further_out():
    """A cycle overshoots a single target; that alone is no reason to run the fan."""
    den = _room("Den", 68.0, heat_to=None, cool_to=None)
    at = lambda temp: [_room("Loft", temp, heat_to=70.0, cool_to=70.0), den]  # noqa: E731
    assert fan.decide(at(72.0), "cooling", running=False) is None
    assert fan.decide(at(72.5), "cooling", running=False) is not None
    # Once running it goes on until the room is back, like any other.
    assert fan.decide(at(70.5), "cooling", running=True) is not None


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

    def __init__(self, client, fake_ha, *, met: bool = True) -> None:
        self.client, self.ha = client, fake_ha
        # Thermostats that are there to be told things.
        for tid in (T1, "climate.other", "climate.gone"):
            if fake_ha.get_state(tid) is None:
                fake_ha.seed_state(tid, "heat", {})
        # As if the zones had been seen before: a manager that has only just
        # started waits out a run that may have ended before it did.
        self.manager = fan.Manager(_met={T1, "climate.other"}) if met else fan.Manager()
        self.said: list[str] = []
        self.opened: list[list[str]] = []

    async def tick(self, zone, now=NOW, outside=None, unit="F", dry=False) -> str:
        conn = await self.client.app["scheduler"].get_db()

        async def say(message, _details):
            self.said.append(message)

        async def open_vents(room_ids):
            self.opened.append(room_ids)

        zones = [] if zone is None else [zone]
        await self.manager.tick(
            conn, self.ha, zones, outside, now, say=say, open_vents=open_vents, unit=unit, dry=dry
        )
        return self.manager.note(T1)

    def modes(self) -> list[str]:
        return [c.data["fan_mode"] for c in self.ha.calls_for("set_fan_mode")]


async def test_the_fan_is_turned_on_and_handed_back(client, fake_ha):
    run = _Run(client, fake_ha)
    note = await run.tick(_zone())
    assert run.modes() == ["on"]
    assert note == "Running: Loft is 2.0°F past its target and another room is 3.0°F closer to it"
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


async def test_after_a_start_the_fan_waits_out_a_run_it_could_not_have_seen(client, fake_ha):
    run = _Run(client, fake_ha, met=False)
    assert await run.tick(_zone()) == "Waiting 15 min after the last run"
    assert (await run.tick(_zone(), NOW + timedelta(minutes=15))).startswith("Running:")


async def test_a_thermostat_that_is_not_answering_keeps_its_fan_remembered(client, fake_ha):
    run = _Run(client, fake_ha)
    await run.tick(_zone())
    away = _zone(available=False, supported=False, fan_mode=None)
    assert await run.tick(away, NOW + timedelta(minutes=1)) == (
        "This thermostat has no fan setting HomeClimate can switch"
    )
    assert run.modes() == ["on"] and run.manager.running(T1)
    # Back, with the fan still on and nothing left to mix: handed back now.
    still = [_room("Loft", 71.0), _room("Den", 71.0)]
    await run.tick(_zone(fan_mode="on", rooms=still), NOW + timedelta(minutes=2))
    assert run.modes() == ["on", "auto"] and not run.manager.running(T1)


async def test_the_room_a_running_fan_is_for_follows_whoever_needs_it(client, fake_ha):
    run = _Run(client, fake_ha)
    await run.tick(_zone())
    assert run.manager._for == {T1: "loft"}
    rooms = [_room("Loft", 72.0), _room("Attic", 75.0), _room("Den", 71.0)]
    await run.tick(_zone(fan_mode="on", rooms=rooms), NOW + timedelta(minutes=1))
    assert run.manager._for == {T1: "attic"} and run.modes() == ["on"]


async def test_in_developer_mode_nothing_is_turned_on_and_a_running_fan_is_still_handed_back(
    client, fake_ha
):
    run = _Run(client, fake_ha)
    await run.tick(_zone())
    assert run.modes() == ["on"]
    fake_ha.dev_mode = True
    # Already running for real: it goes on being looked after, and is handed
    # back with a real command when it is done.
    assert (await run.tick(_zone(fan_mode="on"), NOW + timedelta(minutes=1), dry=True)).startswith(
        "Running:"
    )
    still = [_room("Loft", 71.0), _room("Den", 71.0)]
    await run.tick(_zone(fan_mode="on", rooms=still), NOW + timedelta(minutes=2), dry=True)
    assert run.modes() == ["on", "auto"] and not run.manager.running(T1)
    # A new reason is only said, once, and never recorded as a running fan.
    for minute in (20, 21):
        note = await run.tick(_zone(), NOW + timedelta(minutes=minute), dry=True)
        assert note.startswith("Would run: Loft")
    assert run.modes() == ["on", "auto"] and not run.manager.running(T1)
    assert run.said[-1].startswith("Fan would run for Main (Developer Mode): Loft")
    assert len([m for m in run.said if "Developer Mode" in m]) == 1
    # Developer Mode coming on in the middle of a tick is caught at the send.
    assert await run.tick(_zone(), NOW + timedelta(minutes=22)) == (
        "The thermostat did not accept the fan change"
    )
    assert not run.manager.running(T1)


async def test_a_thermostat_that_is_away_is_not_told_to_stop_by_any_route(client, fake_ha):
    run = _Run(client, fake_ha)
    conn = await client.app["scheduler"].get_db()
    fake_ha.seed_state(T1, "heat", {})
    await run.tick(_zone())
    fake_ha.seed_state(T1, "unavailable", {})
    # Its zone is gone, or the zones cannot be read: still remembered.
    await run.tick(None, NOW + timedelta(minutes=1))
    await run.manager.release(conn, fake_ha, NOW + timedelta(minutes=1))
    assert run.modes() == ["on"] and run.manager.running(T1)
    fake_ha.seed_state(T1, "heat", {})
    await run.tick(None, NOW + timedelta(minutes=2))
    assert run.modes() == ["on", "auto"] and not run.manager.running(T1)


async def test_notes_are_in_the_houses_unit(client, fake_ha):
    run = _Run(client, fake_ha)
    assert await run.tick(_zone(), unit="C") == (
        "Running: Loft is 1.1°C past its target and another room is 1.7°C closer to it"
    )


async def test_one_zones_trouble_does_not_leave_anothers_fan_unattended(client, fake_ha, caplog):
    run = _Run(client, fake_ha)
    conn = await client.app["scheduler"].get_db()
    other = _zone(thermostat_entity_id="climate.other", name="Other")

    async def say(_message, _details):
        return None

    async def broken_vents(_room_ids):
        raise RuntimeError("database is locked")

    await run.manager.tick(
        conn, fake_ha, [_zone(), other], None, NOW, say=say, open_vents=broken_vents
    )
    assert "Could not run the fan for climate.main" in caplog.text
    # Both were still turned on and are still looked after.
    assert run.manager.running(T1) and run.manager.running("climate.other")
    # When the zones cannot be read at all, every fan is handed back.
    await run.manager.release(conn, fake_ha, NOW + timedelta(minutes=1))
    assert run.modes() == ["on", "on", "auto", "auto"]
    assert not run.manager.running(T1)
    assert json.loads(await db.get_system_setting(conn, fan.RUNNING_SETTING, "")) == []


async def test_a_zone_that_is_gone_has_its_fan_handed_back(client, fake_ha, monkeypatch):
    run = _Run(client, fake_ha)
    conn = await client.app["scheduler"].get_db()
    await run.tick(_zone())

    async def refuse(*_a, **_k):
        raise RuntimeError("unavailable")

    # While the thermostat does not answer, the fans stay HomeClimate's to stop.
    monkeypatch.setattr(fake_ha, "call_service", refuse)
    await run.tick(None, NOW + timedelta(minutes=1))
    assert run.manager.running(T1)
    await run.manager.release(conn, fake_ha, NOW + timedelta(minutes=1))
    assert run.manager.running(T1)
    monkeypatch.undo()
    await run.tick(None, NOW + timedelta(minutes=2))
    assert not run.manager.running(T1)
    assert run.modes()[-1] == "auto"


async def test_what_keeps_the_fan_off(client, fake_ha):
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
        run = _Run(client, fake_ha)
        assert await run.tick(_zone(**over)) == note, over
        assert run.modes() == []
        assert not run.manager.running(T1)
    # Whatever the equipment is doing by itself is a run to wait out.
    run = _Run(client, fake_ha)
    await run.tick(_zone(idle=False, cycle_mode="defrosting"))
    assert await run.tick(_zone(), NOW + timedelta(minutes=1)) == (
        "Waiting 14 min after the last run"
    )
    run = _Run(client, fake_ha)
    # A fan somebody else turned on is never turned off either.
    await run.tick(_zone(fan_mode="on", rooms=[_room("Loft", 71.0), _room("Den", 71.0)]))
    assert run.modes() == []


async def test_watching_only_says_what_it_would_do_once(client, fake_ha):
    run = _Run(client, fake_ha)
    note = await run.tick(_zone(level="watch"))
    assert note.startswith("Would run: Loft is 2.0°F past its target")
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
    # Handed back whatever Home Assistant last reported: a report that lags
    # behind must not leave the fan running.
    await run.tick(_zone(), NOW + timedelta(minutes=30))
    await run.tick(_zone(fan_mode="auto", level="off"), NOW + timedelta(minutes=31))
    assert run.modes() == ["on", "auto", "on", "auto", "on", "auto"]
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
    assert await run.tick(idle, NOW + timedelta(minutes=5)) == "Waiting 10 min after the last run"
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
    # While it is still wanted it keeps running, and counts toward the hour.
    # The zone that is gone has its fan handed back before it is forgotten.
    await run.tick(_zone(fan_mode="on"))
    assert [c.data for c in fake_ha.calls_for("set_fan_mode")] == [
        {"entity_id": "climate.gone", "fan_mode": "auto"}
    ]
    fake_ha.reset_calls()
    assert run.manager.running(T1)
    assert run.manager.minutes_used(T1, NOW + timedelta(minutes=9)) == 9
    still = [_room("Loft", 71.0), _room("Den", 71.0)]
    await run.tick(_zone(fan_mode="on", rooms=still), NOW + timedelta(minutes=9))
    assert run.modes() == ["auto"]
    assert json.loads(await db.get_system_setting(conn, fan.RUNNING_SETTING, "")) == []
    for junk in ("not json", '{"a": 1}'):
        await db.set_system_setting(conn, fan.RUNNING_SETTING, junk)
        fresh = _Run(client, fake_ha)
        await fresh.tick(None)
        assert not fresh.manager.running(T1)


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
    client.app["scheduler"].fans._met.add(T1)
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
    assert got["running"] and got["note"].startswith("Running: Loft is 3.0°F past its target")
    # The intake test is gone: nothing about it is reported, and its route is not there.
    assert "testing" not in got and "test" not in got
    assert (await client.post(f"/api/fan/{T1}/test")).status in (404, 405)
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


async def test_a_room_with_no_vents_and_a_house_with_no_log_are_no_trouble(client, fake_ha, home):
    scheduler = client.app["scheduler"]
    resp = await client.post("/api/rooms", json={"name": "Hall", "thermostat_entity_id": T1})
    fake_ha.reset_calls()
    await scheduler._open_room_vents([(await resp.json())["id"]])
    assert fake_ha.calls_for("open_cover") == []
    scheduler._event_logger = None
    await scheduler._say_fan("Fan stopped for Main", {})


async def test_the_fan_settings_are_checked(client, home):
    for body in ({"fan_level": "high"}, {"air_intake": "maybe"}):
        resp = await client.put(f"/api/zones/{T1}", json=body)
        assert resp.status == 400, body


async def test_a_failure_in_the_fan_never_stops_the_tick(client, home, tick, monkeypatch, caplog):
    async def _boom():
        raise RuntimeError("database is locked")

    scheduler = client.app["scheduler"]
    monkeypatch.setattr(scheduler, "fan_zones", _boom)
    await tick()
    assert "Could not run the fans" in caplog.text

    async def _boom_too(*_a, **_k):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(scheduler.fans, "release", _boom_too)
    await tick()
    assert "Could not hand the fans back to their thermostats" in caplog.text
