"""Today's plan: the forecast strip, what is coming up, and yesterday."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import forecast, house, today, tz

pytestmark = pytest.mark.asyncio

T = "climate.today_zone"
NOW = datetime(2026, 7, 6, 14, 20, tzinfo=UTC)  # a Monday


@pytest.fixture(autouse=True)
def utc(monkeypatch):
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)


async def test_what_an_hour_asks_for():
    assert [today.need(t, 60.0, 70.0) for t in (59.9, 60.0, 65.0, 70.0, 70.1)] == [
        "heat",
        "coast",
        "coast",
        "coast",
        "cool",
    ]


async def test_with_nothing_set_up_there_is_only_yesterday(client):
    body = await (await client.get("/api/today")).json()
    assert body["hours"] == [] and body["events"] == []
    assert body["forecast_fetched_at"] is None
    assert (body["heat_below"], body["cool_above"]) == (60.0, 70.0)
    assert body["yesterday"] == "Yesterday nothing ran. No warnings."
    assert datetime.fromisoformat(body["now"]).tzinfo is not None


async def test_the_strip_follows_the_house_band_and_events_come_in_order(client, fake_ha):
    conn = await client.app["scheduler"].get_db()
    fake_ha.seed_state(T, "heat_cool", {"current_temperature": 72, "hvac_action": "idle"})
    ids = {}
    for name in ("Bunk Room", "Craft Room", "Den"):
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": T})
        ids[name] = (await resp.json())["id"]
    await house.set_band(conn, 66.0, 76.0)
    await forecast.update_settings(conn, {"correct": False})
    start = NOW.replace(minute=0)
    # 30 hours: the strip stops at 24 from now.
    for n in range(30):
        temp = 60 + n if n < 20 else 90
        await conn.execute(
            "INSERT INTO forecast_hours(at, temp, fetched_at) VALUES(?, ?, ?)",
            (
                int((start + timedelta(hours=n)).timestamp()),
                temp * forecast.TEMP_SCALE,
                int(NOW.timestamp()),
            ),
        )
    await conn.commit()
    # Blocks at 18:00 today (banded), 09:00 tomorrow, and one the day after
    # (too far off); a block in a room switched out of use, and one in a room
    # told not to follow schedules.
    for name, days, at, body in (
        ("Bunk Room", [0], "18:00", {"target_temp": 68, "cool_to": 74}),
        ("Craft Room", [1], "09:00", {"target_temp": 70}),
        ("Craft Room", [2], "09:00", {"target_temp": 71}),
        ("Den", [0], "17:00", {"target_temp": 69}),
    ):
        resp = await client.post(
            f"/api/rooms/{ids[name]}/schedules",
            json={"days_of_week": days, "start_time": at, "end_time": "23:00"} | body,
        )
        assert resp.status == 201, await resp.text()
    await house.set_switches(conn, ids["Den"], {"use_schedules": False})
    resp = await client.put(
        "/api/peak-hours",
        json={"enabled": True, "start": "16:00", "end": "19:00", "lead_min": 60},
    )
    assert resp.status == 200, await resp.text()

    body = await today.build(conn, now=NOW)
    assert len(body["hours"]) == 24 and body["hours"][0]["at"] == start.isoformat()
    assert [h["need"] for h in body["hours"][:18]] == ["heat"] * 6 + ["coast"] * 11 + ["cool"]
    assert body["hours"][5]["temp"] == 65.0
    assert (body["heat_below"], body["cool_above"]) == (66.0, 76.0)
    assert body["forecast_fetched_at"] == NOW.isoformat()
    assert [(e["kind"], e["at"][11:16]) for e in body["events"]] == [
        ("peak_bank", "15:00"),
        ("peak_start", "16:00"),
        ("schedule", "18:00"),
        ("peak_end", "19:00"),
        ("schedule", "09:00"),
    ]
    bunk = body["events"][2]
    assert (bunk["room"], bunk["room_id"], bunk["target"], bunk["cool_to"]) == (
        "Bunk Room",
        ids["Bunk Room"],
        68.0,
        74.0,
    )
    assert body["events"][4]["cool_to"] is None

    # A room out of use has no events.
    await house.set_switches(conn, ids["Bunk Room"], {"in_use": False})
    kinds = [e["kind"] for e in (await today.build(conn, now=NOW))["events"]]
    assert kinds == ["peak_bank", "peak_start", "peak_end", "schedule"]
    # During the peak only its end is still to come; switched off, nothing of it is.
    during = await today.build(conn, now=NOW.replace(hour=17))
    assert [e["kind"] for e in during["events"]][:1] == ["peak_end"]
    await client.put("/api/peak-hours", json={"enabled": False})
    assert [e["kind"] for e in (await today.build(conn, now=NOW))["events"]] == ["schedule"]
    # With the forecast correction on and nothing learned, the strip is the same.
    await forecast.update_settings(conn, {"correct": True})
    assert (await today.build(conn, now=NOW))["hours"] == body["hours"]
    # Never more than a handful of events.
    for hour in range(10, 14):
        await client.post(
            f"/api/rooms/{ids['Craft Room']}/schedules",
            json={
                "days_of_week": [1],
                "start_time": f"0{hour - 9}:00",
                "end_time": f"0{hour - 9}:30",
                "target_temp": 70,
            },
        )
    for name in ("A", "B", "C", "D", "E", "F"):
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": T})
        await client.post(
            f"/api/rooms/{(await resp.json())['id']}/schedules",
            json={
                "days_of_week": [0],
                "start_time": "20:00",
                "end_time": "21:00",
                "target_temp": 70,
            },
        )
    assert len((await today.build(conn, now=NOW))["events"]) == today.MAX_EVENTS


async def test_events_are_in_order_and_at_the_right_hour_in_the_houses_own_zone(
    client, fake_ha, monkeypatch
):
    from zoneinfo import ZoneInfo

    chicago = ZoneInfo("America/Chicago")
    monkeypatch.setattr(tz, "get_timezone", lambda: chicago)
    conn = await client.app["scheduler"].get_db()
    fake_ha.seed_state(T, "heat_cool", {"current_temperature": 72, "hvac_action": "idle"})
    ids = {}
    for name in ("Bunk Room", "Far Room"):
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": T})
        ids[name] = (await resp.json())["id"]
    # Monday 09:20 in the house. A block at 14:00 today and on Sunday at 08:00;
    # a room whose only block is on Wednesday; peak hours 16:00 to 19:00.
    for name, days, at in (
        ("Bunk Room", [0], "14:00"),
        ("Bunk Room", [6], "08:00"),
        ("Far Room", [2], "10:00"),
    ):
        resp = await client.post(
            f"/api/rooms/{ids[name]}/schedules",
            json={"days_of_week": days, "start_time": at, "end_time": "23:00", "target_temp": 70},
        )
        assert resp.status == 201, await resp.text()
    await client.put(
        "/api/peak-hours",
        json={"enabled": True, "start": "16:00", "end": "19:00", "lead_min": 60},
    )
    monday = datetime(2026, 7, 6, 9, 20, tzinfo=chicago)
    events = (await today.build(conn, now=monday))["events"]
    # In the order they happen, whatever offset each was worked out in, and
    # nothing from more than a day away.
    assert [(e["kind"], e["at"]) for e in events] == [
        ("schedule", "2026-07-06T19:00:00+00:00"),
        ("peak_bank", "2026-07-06T20:00:00+00:00"),
        ("peak_start", "2026-07-06T21:00:00+00:00"),
        ("peak_end", "2026-07-07T00:00:00+00:00"),
    ]
    # A peak that is only on Wednesdays is more than a day off.
    await client.put("/api/peak-hours", json={"days": [2]})
    assert [e["kind"] for e in (await today.build(conn, now=monday))["events"]] == ["schedule"]
    # The night the clocks go back, Sunday's 08:00 block is at 08:00 on the new clock.
    saturday = datetime(2026, 10, 31, 23, 0, tzinfo=chicago)
    [event] = (await today.build(conn, now=saturday))["events"]
    assert event["at"] == "2026-11-01T14:00:00+00:00"  # 08:00 CST
