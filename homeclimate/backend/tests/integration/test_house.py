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
    scheduler = client.app["scheduler"]
    scheduler._active_unit = "C"
    try:
        resp = await _set(client, 30, 35)
        # 84 °F is 28.89 °C and 61 °F is 16.11 °C: named so that they are accepted.
        assert (await resp.json())["error"] == (
            "The band must sit inside every zone's safety limits: Heat To at most 28.8°C"
            " and Cool To at least 16.2°C"
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
