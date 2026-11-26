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


TARGETS = f"/api/house/targets/zone/{T1}"


async def _set(client, heat, cool):
    """Set the zone's targets, which every room in it inherits."""
    return await client.put(TARGETS, json={"house_heat_to": heat, "house_cool_to": cool})


def _band(snap) -> tuple:
    """The zone's (heating, cooling) targets in a snapshot, or (None, None)."""
    for level in snap["targets"]:
        if (level["scope"], level["scope_id"]) == ("zone", T1):
            return level["house_heat_to"], level["house_cool_to"]
    return None, None


async def test_with_no_house_band_nothing_changes(client, rooms):
    snap = await (await client.get("/api/house")).json()
    assert _band(snap) == (None, None)
    assert (snap["min_gap"], snap["low"], snap["high"]) == (0.0, 45.0, 95.0)
    assert snap["targets"] == []
    assert snap["rooms"] == [
        {
            "room_id": rooms["bunk"],
            "in_use": True,
            "use_schedules": True,
            "use_presence": True,
            "calendar": None,
        },
        {
            "room_id": rooms["craft"],
            "in_use": True,
            "use_schedules": True,
            "use_presence": True,
            "calendar": None,
        },
    ]
    assert await _sources(client) == {}


async def test_every_room_follows_the_house_band(client, rooms):
    snap = await (await _set(client, 68, 74)).json()
    assert _band(snap) == (68.0, 74.0)
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
    span = (
        "The targets must be between 45.0 and 95.0°F, and the cooling"
        " target cannot be below the heating target"
    )
    for body, message in (
        ({"house_heat_to": 68, "house_cool_to": None}, both),
        ({"house_heat_to": None, "house_cool_to": 74}, both),
        ({"house_heat_to": 68}, both),
        ({}, both),  # an empty body must not clear the band
        ({"house_heat_to": "68", "house_cool_to": 74}, numbers),
        ({"house_heat_to": 68, "house_cool_to": True}, numbers),
        ({"house_heat_to": 68, "house_cool_to": 10**400}, numbers),
        ({"house_heat_to": 74, "house_cool_to": 72}, span),
        ({"house_heat_to": 40, "house_cool_to": 74}, span),
        ({"house_heat_to": 68, "house_cool_to": 99}, span),
    ):
        resp = await client.put(TARGETS, json=body)
        assert resp.status == 400, body
        assert (await resp.json())["error"] == message
    resp = await client.put(TARGETS, json={"house_heat_to": 68, "nope": 1})
    assert (await resp.json())["error"] == "Unknown targets setting"
    # The two may be close together, or the same number.
    assert (await _set(client, 71, 72)).status == 200
    assert (await _set(client, 71, 71)).status == 200
    assert _band(await (await client.get("/api/house")).json()) == (71.0, 71.0)

    scheduler = client.app["scheduler"]
    scheduler._active_unit = "C"
    try:
        snap = await (await _set(client, 20, 24)).json()
        assert _band(snap) == (68.0, 75.2)  # always °F out
        resp = await _set(client, 20, 19)
        # The bounds named are ones that would be accepted.
        assert (await resp.json())["error"] == (
            "The targets must be between 7.3 and 35.0°C, and the cooling"
            " target cannot be below the heating target"
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
        "The targets must sit inside the zones' safety limits: heating at most 84.0°F"
        " and cooling at least 61.0°F"
    )
    for heat, cool in ((88, 95), (45, 50), (84.5, 90)):
        resp = await _set(client, heat, cool)
        assert (resp.status, (await resp.json())["error"]) == (400, message), (heat, cool)
    assert (await _set(client, 84, 95)).status == 200
    assert (await _set(client, 45, 61)).status == 200
    scheduler = client.app["scheduler"]
    scheduler._active_unit = "C"
    try:
        resp = await _set(client, 30, 35)
        # 84 °F is 28.89 °C and 61 °F is 16.11 °C: named so that they are accepted.
        assert (await resp.json())["error"] == (
            "The targets must sit inside the zones' safety limits: heating at most 28.8°C"
            " and cooling at least 16.2°C"
        )
        assert (await _set(client, 28.8, 35)).status == 200
        assert (await _set(client, 7.3, 16.2)).status == 200
    finally:
        scheduler._active_unit = "F"


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
    for stored in ("warm,74", "68", "74,68", "40,74", "68,74,80"):
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


CAL = "calendar.custody"


def _event(starts_in_min: float, lasts_min: float = 2880, summary: str = "Girls here") -> dict:
    start = datetime.now(UTC) + timedelta(minutes=starts_in_min)
    return {
        "start": start.isoformat(),
        "end": (start + timedelta(minutes=lasts_min)).isoformat(),
        "summary": summary,
    }


async def _in_use(client, room_id: str) -> bool:
    snap = await (await client.get("/api/house")).json()
    return next(bool(r["in_use"]) for r in snap["rooms"] if r["room_id"] == room_id)


async def _say(client, fake_ha, events) -> None:
    fake_ha.calendars = {CAL: events}
    await client.app["scheduler"]._refresh_room_calendars()


async def test_a_room_in_use_follows_a_calendar(client, fake_ha, rooms):
    await _set(client, 68, 74)
    fake_ha.calendars = {CAL: []}
    url = f"/api/house/rooms/{rooms['bunk']}/calendar"
    snap = await (await client.put(url, json={"entity_id": CAL})).json()
    assert snap["rooms"][0]["calendar"] == {
        "entity_id": CAL,
        "match_text": "",
        "lead_min": 120,
        "unreadable": False,
    }
    # No event on and none coming: not in use, so it follows nothing.
    assert snap["rooms"][0]["in_use"] is False
    assert "Bunk Room" not in await _sources(client)

    # An event is on: in use, and following the house band again.
    await _say(client, fake_ha, [_event(-60)])
    assert await _in_use(client, rooms["bunk"]) is True
    assert (await _sources(client))["Bunk Room"][0] == "house"

    # Over, with the next one three hours off: outside the two-hour lead.
    await _say(client, fake_ha, [_event(-600, lasts_min=60), _event(180)])
    assert await _in_use(client, rooms["bunk"]) is False
    # Ninety minutes off: inside the lead, so the room is ready on arrival.
    await _say(client, fake_ha, [_event(90)])
    assert await _in_use(client, rooms["bunk"]) is True
    # A shorter lead takes effect straight away.
    snap = await (await client.put(url, json={"lead_min": 30})).json()
    assert snap["rooms"][0]["in_use"] is False

    events = await (await client.get("/api/logs/events?category=engine")).json()
    messages = [e["message"] for e in events]
    assert "Bunk Room is in use (calendar)" in messages
    assert "Bunk Room is not in use (calendar)" in messages


async def test_an_unrelated_event_cannot_hide_the_one_that_matters(client, fake_ha, rooms):
    fake_ha.calendars = {CAL: [_event(-30, summary="Dentist")]}
    url = f"/api/house/rooms/{rooms['bunk']}/calendar"
    await client.put(url, json={"entity_id": CAL, "match_text": " girls "})
    assert await _in_use(client, rooms["bunk"]) is False
    # The dentist is still on, and the girls arrive in an hour: both are seen.
    await _say(
        client,
        fake_ha,
        [_event(-30, lasts_min=120, summary="Dentist"), _event(60, summary="GIRLS here this week")],
    )
    assert await _in_use(client, rooms["bunk"]) is True
    # Events that cannot be read as events are passed over.
    await _say(
        client,
        fake_ha,
        ["junk", {"summary": "girls", "start": "soon", "end": "later"}, {"summary": "girls"}],
    )
    assert await _in_use(client, rooms["bunk"]) is False


async def test_all_day_events_run_from_midnight_in_the_house_zone(client, fake_ha, rooms):
    from backend import tz

    today = datetime.now(tz.get_timezone()).date()
    fake_ha.calendars = {
        CAL: [
            {
                "start": today.isoformat(),
                "end": (today + timedelta(days=1)).isoformat(),
                "summary": "Girls here",
            }
        ]
    }
    await client.put(f"/api/house/rooms/{rooms['bunk']}/calendar", json={"entity_id": CAL})
    assert await _in_use(client, rooms["bunk"]) is True


async def test_a_calendar_that_stops_answering_falls_back_to_in_use(
    client, fake_ha, rooms, monkeypatch, caplog
):
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    watch = scheduler.calendars
    fake_ha.calendars = {CAL: []}
    url = f"/api/house/rooms/{rooms['bunk']}/calendar"
    await client.put(url, json={"entity_id": CAL})
    assert await _in_use(client, rooms["bunk"]) is False

    # The entity is renamed or removed: at first nothing changes…
    fake_ha.calendars = {CAL: RuntimeError("entity not found")}
    now = datetime.now(UTC)
    assert await watch.refresh(conn, fake_ha, now) == ([], [])
    assert await watch.refresh(conn, fake_ha, now + timedelta(minutes=29)) == ([], [])
    assert await _in_use(client, rooms["bunk"]) is False
    # …and after half an hour the room is put back in use, and it says so, once.
    later = now + timedelta(minutes=31)
    assert await watch.refresh(conn, fake_ha, later) == ([(rooms["bunk"], True)], [rooms["bunk"]])
    assert await watch.refresh(conn, fake_ha, later + timedelta(minutes=1)) == ([], [])
    snap = await (await client.get("/api/house")).json()
    assert (snap["rooms"][0]["in_use"], snap["rooms"][0]["calendar"]["unreadable"]) == (True, True)

    # It answers again: believed straight away.
    fake_ha.calendars = {CAL: []}
    await scheduler._refresh_room_calendars()
    snap = await (await client.get("/api/house")).json()
    assert (snap["rooms"][0]["in_use"], snap["rooms"][0]["calendar"]["unreadable"]) == (
        False,
        False,
    )

    # Through the scheduler the give-up is a warning in the log.
    fake_ha.calendars = {}
    watch._unreadable_since[rooms["bunk"]] = datetime.now(UTC) - timedelta(minutes=40)
    await scheduler._refresh_room_calendars()
    events = await (await client.get("/api/logs/events?category=engine")).json()
    assert (
        "The calendar Bunk Room follows has not answered for 30 minutes;"
        " treating the room as in use until it does"
    ) in [e["message"] for e in events]

    # Home Assistant itself away: nothing is concluded, and nothing is counted.
    fake_ha._connected.clear()
    try:
        assert await watch.refresh(conn, fake_ha, datetime.now(UTC) + timedelta(hours=5)) == (
            [],
            [],
        )
    finally:
        fake_ha._connected.set()

    # Unlinking forgets the outage; a fault in the reader never escapes the tick.
    await client.delete(url)
    await scheduler._refresh_room_calendars()
    assert watch.unreadable() == set()
    logger, scheduler._event_logger = scheduler._event_logger, None
    try:
        await scheduler._refresh_room_calendars()
    finally:
        scheduler._event_logger = logger

    async def boom(*_a, **_k):
        raise RuntimeError("db gone")

    monkeypatch.setattr(watch, "refresh", boom)
    await scheduler._refresh_room_calendars()
    assert "Could not read room calendars" in caplog.text


async def test_in_use_cannot_be_set_by_hand_while_following_a_calendar(client, fake_ha, rooms):
    fake_ha.calendars = {CAL: [_event(-60)]}
    url = f"/api/house/rooms/{rooms['bunk']}/calendar"
    await client.put(url, json={"entity_id": CAL})
    resp = await client.put(f"/api/house/rooms/{rooms['bunk']}", json={"in_use": False})
    assert (resp.status, (await resp.json())["error"]) == (
        400,
        "This room's In Use follows a calendar; stop following it to set it by hand",
    )
    # The other switches still work.
    resp = await client.put(f"/api/house/rooms/{rooms['bunk']}", json={"use_presence": False})
    assert resp.status == 200

    # Unlinking keeps, by hand, the state the calendar last gave.
    await _say(client, fake_ha, [])
    snap = await (await client.delete(url)).json()
    assert (snap["rooms"][0]["calendar"], snap["rooms"][0]["in_use"]) == (None, False)
    resp = await client.put(f"/api/house/rooms/{rooms['bunk']}", json={"in_use": True})
    assert resp.status == 200
    assert (await client.delete(url)).status == 404


async def test_calendar_links_are_validated(client, fake_ha, rooms):
    fake_ha.calendars = {CAL: []}
    url = f"/api/house/rooms/{rooms['bunk']}/calendar"
    lead = "lead_min must be a whole number of minutes from 0 to 1440"
    for body, message in (
        ({"entity_id": "switch.x"}, "entity_id must be a calendar entity"),
        ({"entity_id": "calendar."}, "entity_id must be a calendar entity"),
        ({"entity_id": 5}, "entity_id must be a calendar entity"),
        ({"entity_id": CAL, "match_text": 5}, "match_text must be text of up to 60 characters"),
        (
            {"entity_id": CAL, "match_text": "x" * 61},
            "match_text must be text of up to 60 characters",
        ),
        ({"entity_id": CAL, "lead_min": 1441}, lead),
        ({"entity_id": CAL, "lead_min": True}, lead),
        ({"entity_id": CAL, "colour": "red"}, "Unknown calendar field"),
        ({"lead_min": 30}, "Choose the calendar this room follows"),
    ):
        resp = await client.put(url, json=body)
        assert resp.status == 400, body
        assert (await resp.json())["error"] == message
    resp = await client.put("/api/house/rooms/nope/calendar", json={"entity_id": CAL})
    assert (resp.status, (await resp.json())["error"]) == (404, "Room not found")
    # Deleting a room drops its link.
    assert (await client.put(url, json={"entity_id": CAL})).status == 200
    await client.post("/api/rooms", json={"name": "Spare", "thermostat_entity_id": T1})
    await client.delete(f"/api/rooms/{rooms['bunk']}")
    conn = await client.app["scheduler"].get_db()
    assert (await house.load(conn)).calendars == {}


async def test_targets_inherit_room_from_zone_from_building(client, rooms):
    """The most specific level wins; clearing one falls back to the level above."""
    building = (await (await client.post("/api/buildings", json={"name": "Main House"})).json())[
        "id"
    ]
    assert (await client.put(f"/api/zones/{T1}", json={"building_id": building})).status == 200

    async def put(scope, scope_id, heat, cool):
        return await client.put(
            f"/api/house/targets/{scope}/{scope_id}",
            json={"house_heat_to": heat, "house_cool_to": cool},
        )

    # Nothing set anywhere: rooms follow nothing.
    assert {v[0] for v in (await _sources(client)).values()} <= {"idle"}
    # The building's targets reach every room in it, and may be one degree apart.
    assert (await put("building", building, 71, 72)).status == 200
    assert await _sources(client) == {
        "Bunk Room": ("house", 71.0, 72.0),
        "Craft Room": ("house", 71.0, 72.0),
    }
    # The zone's own targets come first for its rooms...
    assert (await put("zone", T1, 69, 75)).status == 200
    assert (await _sources(client))["Bunk Room"] == ("house", 69.0, 75.0)
    # ...and a room's own come first for that room only.
    assert (await put("room", rooms["bunk"], 66, 66)).status == 200
    assert await _sources(client) == {
        "Bunk Room": ("house", 66.0, 66.0),
        "Craft Room": ("house", 69.0, 75.0),
    }
    snap = await (await client.get("/api/house")).json()
    assert [(t["scope"], t["house_heat_to"], t["house_cool_to"]) for t in snap["targets"]] == [
        ("building", 71.0, 72.0),
        ("room", 66.0, 66.0),
        ("zone", 69.0, 75.0),
    ]
    # Clearing a level hands its rooms back to the level above.
    assert (await put("room", rooms["bunk"], None, None)).status == 200
    assert (await put("zone", T1, None, None)).status == 200
    assert (await _sources(client))["Bunk Room"] == ("house", 71.0, 72.0)

    # A level's targets go with it when it is deleted.
    assert (await put("room", rooms["craft"], 65, 77)).status == 200
    assert (await client.delete(f"/api/rooms/{rooms['craft']}")).status == 200
    # A deleted building leaves its targets with the zones that followed
    # them, so their rooms go on being heated and cooled.
    assert (await client.delete(f"/api/buildings/{building}")).status == 200
    snap = await (await client.get("/api/house")).json()
    assert [(t["scope"], t["scope_id"], t["house_heat_to"]) for t in snap["targets"]] == [
        ("zone", T1, 71.0)
    ]
    assert (await _sources(client))["Bunk Room"] == ("house", 71.0, 72.0)
    assert (await put("zone", T1, 70, 71)).status == 200
    assert (await client.delete(f"/api/thermostats/{T1}?with_rooms=true")).status == 200
    assert (await (await client.get("/api/house")).json())["targets"] == []

    # What is not a level, or does not exist, is refused.
    assert (await put("house", "all", 70, 74)).status == 400
    for scope, missing in (("building", "nope"), ("zone", "climate.nope"), ("room", "nope")):
        resp = await put(scope, missing, 70, 74)
        assert (resp.status, (await resp.json())["error"]) == (
            404,
            "That building, zone or room was not found",
        )


async def test_a_zone_leaving_its_building_keeps_the_targets_it_followed(client, rooms):
    conn = await client.app["scheduler"].get_db()
    ids = {}
    for name in ("Main House", "Pool House"):
        ids[name] = (await (await client.post("/api/buildings", json={"name": name})).json())["id"]
    main, pool = ids["Main House"], ids["Pool House"]
    await house.set_level(conn, "building", main, 71, 72)
    await house.set_level(conn, "building", pool, 60, 85)
    assert (await client.put(f"/api/zones/{T1}", json={"building_id": main})).status == 200
    # Between buildings it follows the new one, and is given nothing.
    assert (await client.put(f"/api/zones/{T1}", json={"building_id": pool})).status == 200
    assert (await _sources(client))["Bunk Room"] == ("house", 60.0, 85.0)
    assert ("zone", T1) not in (await house.load(conn)).levels
    # Out of every building, it keeps what it was following...
    assert (await client.put(f"/api/zones/{T1}", json={"building_id": None})).status == 200
    assert (await _sources(client))["Bunk Room"] == ("house", 60.0, 85.0)
    # ...unless it had targets of its own, which stay as they were.
    assert (await client.put(f"/api/zones/{T1}", json={"building_id": main})).status == 200
    assert (await client.put(f"/api/zones/{T1}", json={"building_id": None})).status == 200
    assert (await house.load(conn)).levels[("zone", T1)] == house.Band(60.0, 85.0)
    # A building with no targets hands nothing down.
    await house.set_level(conn, "zone", T1, None, None)
    await house.set_level(conn, "building", main, None, None)
    assert (await client.put(f"/api/zones/{T1}", json={"building_id": main})).status == 200
    assert (await client.put(f"/api/zones/{T1}", json={"building_id": None})).status == 200
    assert ("zone", T1) not in (await house.load(conn)).levels


async def test_only_the_zones_that_targets_reach_limit_them(client, rooms):
    """A pool house capped at 65 says nothing about the main house's targets."""
    ids = {}
    for name in ("Main House", "Pool House"):
        ids[name] = (await (await client.post("/api/buildings", json={"name": name})).json())["id"]
    for tid, top, building in ((T1, 90, "Main House"), ("climate.pool", 65, "Pool House")):
        resp = await client.post(
            "/api/thermostats",
            json={
                "thermostat_entity_id": tid,
                "name": tid,
                "min_setpoint": 50,
                "max_setpoint": top,
                "total_vents_count": 4,
            },
        )
        assert resp.status in (200, 201), await resp.text()
        resp = await client.put(f"/api/zones/{tid}", json={"building_id": ids[building]})
        assert resp.status == 200, await resp.text()

    async def put(scope, scope_id):
        resp = await client.put(
            f"/api/house/targets/{scope}/{scope_id}",
            json={"house_heat_to": 68, "house_cool_to": 74},
        )
        return resp.status

    assert await put("building", ids["Main House"]) == 200
    assert await put("zone", T1) == 200
    assert await put("room", rooms["bunk"]) == 200
    assert await put("building", ids["Pool House"]) == 400
    assert await put("zone", "climate.pool") == 400
    # A building with no zones yet has no limits to answer to.
    empty = (await (await client.post("/api/buildings", json={"name": "Barn"})).json())["id"]
    assert await put("building", empty) == 200
    conn = await client.app["scheduler"].get_db()
    assert await house.zones_under(conn, "room", "gone") == set()


async def test_the_forecast_is_judged_against_every_target_in_use(client, rooms):
    conn = await client.app["scheduler"].get_db()
    main = (await (await client.post("/api/buildings", json={"name": "Main House"})).json())["id"]
    assert (await client.put(f"/api/zones/{T1}", json={"building_id": main})).status == 200
    # Nothing set: nothing to judge by.
    loaded = await house.load(conn)
    assert (loaded.outer_band(), loaded.building_outer_band(main)) == (None, None)
    # Only the zone has targets; its building still has a band to judge by.
    await house.set_level(conn, "zone", T1, 69, 73)
    await house.set_level(conn, "zone", "climate.elsewhere", 50, 90)
    await house.set_level(conn, "room", rooms["bunk"], 64, 71)
    loaded = await house.load(conn)
    assert loaded.building_outer_band(main) == house.Band(69.0, 73.0)
    assert loaded.outer_band() == house.Band(50.0, 90.0)
    await house.set_level(conn, "building", main, 71, 72)
    assert (await house.load(conn)).building_outer_band(main) == house.Band(69.0, 73.0)


async def test_a_house_band_from_an_earlier_version_is_handed_to_the_levels(client, rooms):
    conn = await client.app["scheduler"].get_db()
    # With nothing to give it to, the old band is kept.
    await conn.execute("DELETE FROM rooms")
    await conn.execute("DELETE FROM thermostat_configs")
    await conn.commit()
    await house.set_band(conn, 68, 74)
    assert await house.adopt_house_band(conn) == 0
    assert (await house.load(conn)).band == house.Band(68.0, 74.0)

    # The first building made is given it at once, without a restart.
    building = (await (await client.post("/api/buildings", json={"name": "Main House"})).json())[
        "id"
    ]
    loaded = await house.load(conn)
    assert (loaded.band, loaded.levels) == (None, {("building", building): house.Band(68.0, 74.0)})

    # As on a start after upgrading, with the home already laid out.
    await house.set_level(conn, "building", building, None, None)
    other = (await (await client.post("/api/buildings", json={"name": "Pool House"})).json())["id"]
    for tid in (T1, "climate.loose"):
        resp = await client.post(
            "/api/thermostats",
            json={"thermostat_entity_id": tid, "name": tid, "total_vents_count": 4},
        )
        assert resp.status in (200, 201), await resp.text()
    await client.put(f"/api/zones/{T1}", json={"building_id": building})
    await house.set_band(conn, 68, 74)
    # A level that already has targets keeps them.
    await house.set_level(conn, "building", other, 60, 80)
    # A room whose thermostat was never set up as a zone is still run by
    # the engine, so its thermostat is given the band too.
    await conn.execute(
        "INSERT INTO rooms (id, name, thermostat_entity_id) VALUES ('r-old', 'Attic',"
        " 'climate.unregistered')"
    )
    await conn.commit()

    assert await house.adopt_house_band(conn) == 3
    loaded = await house.load(conn)
    assert loaded.band is None
    assert loaded.levels == {
        ("building", building): house.Band(68.0, 74.0),
        ("building", other): house.Band(60.0, 80.0),
        ("zone", "climate.loose"): house.Band(68.0, 74.0),
        ("zone", "climate.unregistered"): house.Band(68.0, 74.0),
    }
    assert loaded.band_for("any-room", T1) == house.Band(68.0, 74.0)
    assert loaded.outer_band() == house.Band(60.0, 80.0)
    # Running it again changes nothing.
    assert await house.adopt_house_band(conn) == 0
    # The scheduler's own call never raises, whatever the database says.
    await client.app["scheduler"].adopt_house_band()


async def test_the_scheduler_carries_the_old_band_over_and_survives_a_failure(
    client, rooms, monkeypatch
):
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    await house.set_band(conn, 68, 74)
    await scheduler.adopt_house_band()
    loaded = await house.load(conn)
    assert (loaded.band, loaded.levels) == (None, {("zone", T1): house.Band(68.0, 74.0)})

    async def _boom(_conn):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(house, "adopt_house_band", _boom)
    await scheduler.adopt_house_band()  # logged, never raised
