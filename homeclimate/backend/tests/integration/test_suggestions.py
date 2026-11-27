"""Suggestions: advice from recorded history, and nothing before two weeks of it."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import db, suggestions, tz
from backend.models import CycleLog

pytestmark = pytest.mark.asyncio

T1 = "climate.north"
NOW = datetime(2026, 3, 30, 12, 0, tzinfo=UTC)  # a Monday


async def _runs(conn, tid, *, days, a_day, minutes):
    for day in range(days):
        for n in range(a_day):
            log = CycleLog.create(thermostat_entity_id=tid, mode="heating", rooms_json="{}")
            log.started_at = NOW - timedelta(days=days - day, minutes=-n * 60)
            log.ended_at = log.started_at + timedelta(minutes=minutes)
            await db.insert_cycle_log(conn, log)


async def _occupancy(conn, room_id, *, days, hours):
    """A reading every half hour: occupied in ``hours`` (UTC) on weekdays."""
    await conn.execute(
        "INSERT INTO room_reading_keys(key, kind, value) VALUES(1, 'room', ?), (2, 'zone', ?),"
        " (3, 'action', 'idle')",
        (room_id, T1),
    )
    start = NOW - timedelta(days=days)
    for step in range(days * 48):
        at = start + timedelta(minutes=30 * step)
        here = at.weekday() < 5 and at.hour in hours
        await conn.execute(
            "INSERT INTO room_readings(room_key, ts, zone_key, action_key, aux_heat, occupied)"
            " VALUES(1, ?, 2, 3, 0, ?)",
            (int(at.timestamp()), int(here)),
        )
    await conn.commit()


@pytest.fixture
async def room(client, fake_ha, monkeypatch):
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)
    fake_ha.seed_state(T1, "heat", {"current_temperature": 70, "hvac_action": "idle"})
    resp = await client.post("/api/rooms", json={"name": "Bunk Room", "thermostat_entity_id": T1})
    assert resp.status == 201, await resp.text()
    return (await resp.json())["id"]


async def test_with_nothing_recorded_there_is_nothing_to_suggest(client, room):
    body = await (await client.get("/api/learning/suggestions")).json()
    assert body == {"min_days": 14, "window_days": 30, "zones": [], "rooms": []}


async def test_many_short_runs_suggest_a_wider_deadband(client, room):
    conn = await client.app["scheduler"].get_db()
    await _runs(conn, T1, days=20, a_day=10, minutes=5)
    (found,) = (await suggestions.build(conn, now=NOW))["zones"]
    assert found == {
        "kind": "deadband",
        "thermostat_entity_id": T1,
        "name": T1,
        "current": 0.5,
        "suggested": 1.0,
        "runs_a_day": 10.3,
        "typical_run_min": 5.0,
        "days": 19,
    }
    # Already as wide as it is ever suggested.
    tc = await db.get_thermostat_config(conn, T1)
    tc.deadband = 1.75
    await db.upsert_thermostat_config(conn, tc)
    assert (await suggestions.build(conn, now=NOW))["zones"] == []


async def test_runs_that_were_cut_off_and_zones_that_cannot_use_it_are_left_out(client, room):
    conn = await client.app["scheduler"].get_db()
    await _runs(conn, T1, days=20, a_day=10, minutes=5)
    assert len((await suggestions.build(conn, now=NOW))["zones"]) == 1
    # Every room has a deadband of its own: the zone's would change nothing.
    the_room = await db.get_room(conn, room)
    the_room.deadband_override = 1.0
    await db.upsert_room(conn, the_room)
    assert (await suggestions.build(conn, now=NOW))["zones"] == []
    the_room.deadband_override = None
    await db.upsert_room(conn, the_room)
    # Runs that were cut off say nothing about the deadband.
    await conn.execute("UPDATE cycle_logs SET ended_reason = 'aborted: thermostat unavailable'")
    await conn.commit()
    assert (await suggestions.build(conn, now=NOW))["zones"] == []
    await conn.execute("UPDATE cycle_logs SET ended_reason = 'all rooms at target'")
    # A damaged row is passed over.
    await conn.execute("UPDATE cycle_logs SET ended_at = 'x' WHERE rowid = 1")
    await conn.commit()
    assert len((await suggestions.build(conn, now=NOW))["zones"]) == 1
    # A zone that has been removed leaves its history behind, and gets no advice.
    await conn.execute("DELETE FROM thermostat_configs")
    await conn.commit()
    assert (await suggestions.build(conn, now=NOW))["zones"] == []


async def test_long_runs_few_runs_or_too_little_history_suggest_nothing(client, room):
    conn = await client.app["scheduler"].get_db()
    await _runs(conn, T1, days=20, a_day=10, minutes=20)
    assert (await suggestions.build(conn, now=NOW))["zones"] == []
    await conn.execute("DELETE FROM cycle_logs")
    await _runs(conn, T1, days=20, a_day=3, minutes=5)
    assert (await suggestions.build(conn, now=NOW))["zones"] == []
    await conn.execute("DELETE FROM cycle_logs")
    await _runs(conn, T1, days=10, a_day=10, minutes=5)
    assert (await suggestions.build(conn, now=NOW))["zones"] == []
    # A run still going is not counted.
    await conn.execute("UPDATE cycle_logs SET ended_at = NULL")
    await conn.commit()
    assert (await suggestions.build(conn, now=NOW))["zones"] == []


async def test_the_hours_a_room_is_usually_occupied_become_suggested_blocks(client, room):
    conn = await client.app["scheduler"].get_db()
    await _occupancy(conn, room, days=21, hours={7, 8, 18, 19, 20})
    (found,) = (await suggestions.build(conn, now=NOW))["rooms"]
    assert (found["room_id"], found["name"], found["days"]) == (room, "Bunk Room", 21)
    assert found["hours_a_week"] == 25
    assert found["blocks"] == [
        {"days": [0, 1, 2, 3, 4], "start": "07:00", "end": "09:00"},
        {"days": [0, 1, 2, 3, 4], "start": "18:00", "end": "21:00"},
    ]
    # Asked today, months later, that history is too old to speak from.
    resp = await client.get("/api/learning/suggestions")
    assert resp.status == 200 and (await resp.json())["rooms"] == []


async def test_a_room_never_occupied_or_watched_for_too_short_a_time_gets_none(client, room):
    conn = await client.app["scheduler"].get_db()
    await _occupancy(conn, room, days=21, hours=set())
    assert (await suggestions.build(conn, now=NOW))["rooms"] == []
    await conn.execute("DELETE FROM room_readings")
    await conn.execute("DELETE FROM room_reading_keys")
    await _occupancy(conn, room, days=10, hours={7})
    assert (await suggestions.build(conn, now=NOW))["rooms"] == []


async def test_blocks_run_to_midnight_and_group_days_that_match():
    usual = {(5, 22), (5, 23), (6, 22), (6, 23), (0, 6)}
    assert suggestions._blocks(usual) == [
        {"days": [0], "start": "06:00", "end": "07:00"},
        {"days": [5, 6], "start": "22:00", "end": "00:00"},
    ]


async def test_how_much_each_hour_of_the_week_is_used_comes_with_the_room(client, room):
    conn = await client.app["scheduler"].get_db()
    await _occupancy(conn, room, days=21, hours={8, 9})
    (found,) = (await suggestions.build(conn, now=NOW))["rooms"]
    usage = found["usage"]
    assert len(usage) == 7 and all(len(day) == 24 for day in usage)
    # Monday to Friday at 08:00 and 09:00, every reading; never at the weekend.
    assert usage[0][8] == 100 and usage[4][9] == 100
    assert usage[0][7] == 0 and usage[5][8] == 0


async def test_a_room_used_now_and_then_is_shown_with_no_blocks(client, room):
    """Seen in use, but never often enough in one hour to be called usual."""
    conn = await client.app["scheduler"].get_db()
    await conn.execute(
        "INSERT INTO room_reading_keys(key, kind, value) VALUES(1, 'room', ?), (2, 'zone', ?),"
        " (3, 'action', 'idle')",
        (room, T1),
    )
    start = NOW - timedelta(days=21)
    for step in range(21 * 48):
        at = start + timedelta(minutes=30 * step)
        # One reading in four at 20:00.
        here = at.hour == 20 and at.minute == 0 and at.toordinal() % 2 == 0
        await conn.execute(
            "INSERT INTO room_readings(room_key, ts, zone_key, action_key, aux_heat, occupied)"
            " VALUES(1, ?, 2, 3, 0, ?)",
            (int(at.timestamp()), int(here)),
        )
    await conn.commit()
    (found,) = (await suggestions.build(conn, now=NOW))["rooms"]
    assert found["blocks"] == [] and found["hours_a_week"] == 0
    assert 0 < found["usage"][0][20] < 60
