"""GET /api/learning/rooms/{id}/hindcast, and Stop Early in the learning snapshot."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from backend import db, learning, stop_early, tz
from backend.learning import RoomSample

pytestmark = pytest.mark.asyncio

T1 = "climate.north"


@pytest.fixture
async def room(client, fake_ha, monkeypatch):
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)
    fake_ha.seed_state(T1, "heat", {"current_temperature": 70, "hvac_action": "idle"})
    resp = await client.post("/api/rooms", json={"name": "Bunk Room", "thermostat_entity_id": T1})
    return (await resp.json())["id"]


async def test_a_day_of_a_room_is_read_in_the_houses_day(client, room, monkeypatch):
    monkeypatch.setattr(tz, "today_local", lambda: datetime(2026, 2, 3, tzinfo=UTC).date())
    conn = await client.app["scheduler"].get_db()
    start = datetime(2026, 2, 1, 23, 0, tzinfo=UTC)
    await learning.store(
        conn,
        [
            RoomSample(
                ts=start + timedelta(minutes=5 * i),
                room_id=room,
                thermostat_entity_id=T1,
                room_temp=66.0,
                zone_temp=70.0,
                outside_temp=40.0,
                hvac_action="idle",
                aux_heat=False,
                vent_open=0.0,
                zone_vent_open=0.5,
                occupied=None,
                opening=None,
            )
            for i in range(12 * 27)
        ],
    )
    # Yesterday by default; no model yet, so only the measured line.
    body = await (await client.get(f"/api/learning/rooms/{room}/hindcast")).json()
    assert body["room_id"] == room and body["name"] == "Bunk Room" and body["day"] == "2026-02-02"
    assert body["start"] == "2026-02-02T00:00:00+00:00"
    assert len(body["points"]) == 96
    assert body["points"][0] == {
        "at": "2026-02-02T00:00:00+00:00",
        "measured": 66.0,
        "predicted": None,
    }
    assert body["typical_miss"] is None
    assert body["ticks"] == [
        "2026-02-02T00:00:00+00:00",
        "2026-02-02T06:00:00+00:00",
        "2026-02-02T12:00:00+00:00",
        "2026-02-02T18:00:00+00:00",
        "2026-02-03T00:00:00+00:00",
    ]
    # A named day with nothing recorded.
    empty = await (await client.get(f"/api/learning/rooms/{room}/hindcast?day=2026-01-10")).json()
    assert empty["day"] == "2026-01-10" and empty["points"] == []


async def test_a_bad_day_or_an_unknown_room_is_refused(client, room):
    resp = await client.get(f"/api/learning/rooms/{room}/hindcast?day=yesterday")
    assert resp.status == 400
    assert (await resp.json())["error"] == "day must be a date like 2026-01-31"
    resp = await client.get("/api/learning/rooms/nope/hindcast")
    assert resp.status == 404


async def test_what_stop_early_learned_is_shown_with_each_room(client, room):
    conn = await client.app["scheduler"].get_db()
    body = await (await client.get("/api/learning")).json()
    assert body["settings"]["stop_early_level"] == 0
    assert body["rooms"][0]["stop_early"] is None
    learned = {"heating": {"lead": 0.7, "runs": 9}, "cooling": {"lead": 0.0, "runs": 1}}
    await db.set_system_setting(conn, stop_early.KEY, json.dumps({room: learned}))
    resp = await client.put("/api/learning/settings", json={"stop_early_level": 2})
    body = await resp.json()
    assert body["settings"]["stop_early_level"] == 2
    # What is used is at most half the deadband (0.5 for the zone, so 0.25).
    assert body["rooms"][0]["stop_early"] == {
        "heating": {"lead": 0.7, "runs": 9, "used": 0.25},
        "cooling": {"lead": 0.0, "runs": 1, "used": 0.0},
    }
    # A room with its own wider deadband may use more of it.
    await client.put(f"/api/rooms/{room}", json={"deadband_override": 2.0})
    body = await (await client.get("/api/learning")).json()
    assert body["rooms"][0]["stop_early"]["heating"]["used"] == 0.7
    bad = await client.put("/api/learning/settings", json={"stop_early_level": 3})
    assert bad.status == 400
    assert "stop_early_level must be 0" in (await bad.json())["error"]


async def test_the_clock_marks_follow_the_house_on_a_day_the_clocks_change(
    client, room, monkeypatch
):
    from zoneinfo import ZoneInfo

    monkeypatch.setattr(tz, "get_timezone", lambda: ZoneInfo("America/Chicago"))
    # Spring forward: 2026-03-08 has 23 hours in Chicago.
    body = await (await client.get(f"/api/learning/rooms/{room}/hindcast?day=2026-03-08")).json()
    assert body["start"] == "2026-03-08T06:00:00+00:00"
    assert body["end"] == "2026-03-09T05:00:00+00:00"
    assert body["ticks"] == [
        "2026-03-08T06:00:00+00:00",
        "2026-03-08T11:00:00+00:00",
        "2026-03-08T17:00:00+00:00",
        "2026-03-08T23:00:00+00:00",
        "2026-03-09T05:00:00+00:00",
    ]
