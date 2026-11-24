"""The weather forecast: fetch, keep through outages, archive, and report."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import db, forecast

pytestmark = pytest.mark.asyncio

W = "weather.home"


def _entries(start: datetime, temps: list[float], **extra) -> list[dict]:
    return [
        {"datetime": (start + timedelta(hours=i)).isoformat(), "temperature": t, **extra}
        for i, t in enumerate(temps)
    ]


def _this_hour() -> datetime:
    return datetime.now(UTC).replace(minute=0, second=0, microsecond=0)


@pytest.fixture
async def on(client, fake_ha):
    fake_ha.seed_state(W, "sunny", {"temperature_unit": "°F"})
    fake_ha.forecasts = {
        W: _entries(
            _this_hour(),
            [50 + i for i in range(48)],
            cloud_coverage=40,
            precipitation_probability=10,
            condition="sunny",
        )
    }
    resp = await client.put("/api/forecast/settings", json={"enabled": True, "weather_entity": W})
    assert resp.status == 200, await resp.text()
    return await resp.json()


async def test_off_by_default_and_fetches_nothing(client, fake_ha):
    fake_ha.forecasts = {W: RuntimeError("must not be asked")}
    await client.app["scheduler"].refresh_forecast()
    snap = await (await client.get("/api/forecast")).json()
    assert snap["settings"] == {"enabled": False, "weather_entity": ""}
    assert (snap["state"], snap["hours"], snap["days"], snap["problem"]) == ("off", [], [], None)
    # On, but with no weather entity anywhere.
    snap = await (await client.put("/api/forecast/settings", json={"enabled": True})).json()
    assert (snap["state"], snap["weather_entity"]) == ("no_entity", "")


async def test_turning_it_on_fetches_and_reports_the_next_day(client, on):
    assert (on["state"], on["problem"], on["weather_entity"]) == ("fresh", None, W)
    assert on["shared_with_shades"] is False
    assert len(on["hours"]) == 24
    assert on["hours"][0] == {
        "at": _this_hour().isoformat(),
        "temp": 50.0,
        "cloud_pct": 40,
        "precip_pct": 10,
        "condition": "sunny",
    }
    assert on["covers_until"] == (_this_hour() + timedelta(hours=47)).isoformat()
    assert on["fetched_at"] is not None
    # Days are house-local dates; together they cover every forecast hour.
    assert 2 <= len(on["days"]) <= 3
    assert on["days"][0]["low"] == 50.0
    assert on["days"][0]["starts_at"] == _this_hour().isoformat()
    assert all(d["high"] >= d["low"] for d in on["days"])
    if len(on["days"]) == 2:
        assert sum(d["hours"] for d in on["days"]) == 48


async def test_celsius_weather_entities_are_stored_in_fahrenheit(client, fake_ha, on):
    fake_ha.seed_state(W, "sunny", {"temperature_unit": "°C"})
    fake_ha.forecasts[W] = _entries(_this_hour(), [0, 10, 100])
    snap = await (await client.post("/api/forecast/refresh")).json()
    assert [h["temp"] for h in snap["hours"]] == [32.0, 50.0, 212.0]
    assert snap["hours"][0]["cloud_pct"] is None and snap["hours"][0]["condition"] == ""
    # With no unit on the entity, Home Assistant's own unit is assumed.
    fake_ha.seed_state(W, "sunny", {})
    fake_ha.ha_temp_unit = "C"
    try:
        snap = await (await client.post("/api/forecast/refresh")).json()
    finally:
        fake_ha.ha_temp_unit = "F"
    assert snap["hours"][0]["temp"] == 32.0


async def test_a_failed_fetch_keeps_the_last_forecast_and_logs_once(client, fake_ha, on):
    scheduler = client.app["scheduler"]
    fake_ha.forecasts[W] = RuntimeError("timeout talking to weather service")
    snap = await (await client.post("/api/forecast/refresh")).json()
    assert snap["state"] == "kept"
    assert snap["problem"] == forecast.FETCH_FAILED
    assert "timeout" not in str(snap)
    assert len(snap["hours"]) == 24
    await scheduler.refresh_forecast()  # still failing: no second log line
    fake_ha.forecasts[W] = _entries(_this_hour(), [61, 62])
    snap = await (await client.post("/api/forecast/refresh")).json()
    assert (snap["state"], snap["problem"]) == ("fresh", None)
    assert [h["temp"] for h in snap["hours"]] == [61.0, 62.0]  # the old tail is replaced

    events = await (await client.get("/api/logs/events?category=forecast")).json()
    messages = [e["message"] for e in events]
    assert sorted(messages) == ["Forecast fetch failed; keeping the last one", "Forecast is back"]


async def test_nothing_usable_counts_as_a_failure(client, fake_ha, on):
    conn = await client.app["scheduler"].get_db()
    await conn.execute("DELETE FROM forecast_hours")
    await conn.commit()
    fake_ha.forecasts[W] = [
        "junk",
        {"datetime": "not a time", "temperature": 50},
        {"datetime": "2026-01-01T00:00:00", "temperature": 50},  # no zone
        {"datetime": _this_hour().isoformat(), "temperature": None},
        {"datetime": _this_hour().isoformat(), "temperature": True},
        {"datetime": _this_hour().isoformat(), "temperature": float("nan")},
    ]
    snap = await (await client.post("/api/forecast/refresh")).json()
    assert (snap["state"], snap["hours"], snap["problem"]) == ("none", [], forecast.FETCH_FAILED)
    fake_ha.forecasts[W] = "not a list"
    snap = await (await client.post("/api/forecast/refresh")).json()
    assert snap["state"] == "none"


async def test_an_old_forecast_is_kept_not_fresh_and_past_hours_drop_off(client, on):
    conn = await client.app["scheduler"].get_db()
    fc = client.app["scheduler"].forecast
    later = datetime.now(UTC) + timedelta(hours=3)
    snap = await fc.snapshot(conn, now=later)
    assert snap["state"] == "kept" and snap["problem"] is None
    assert snap["hours"][0]["at"] == later.replace(minute=0, second=0, microsecond=0).isoformat()
    gone = await fc.snapshot(conn, now=datetime.now(UTC) + timedelta(days=5))
    assert (gone["state"], gone["fetched_at"], gone["covers_until"]) == ("none", None, None)


async def test_each_clock_hour_archives_one_snapshot_and_old_ones_age_out(client, fake_ha, on):
    conn = await client.app["scheduler"].get_db()

    async def count() -> int:
        async with conn.execute("SELECT COUNT(*) AS n FROM forecast_snapshots") as cur:
            return int((await cur.fetchone())["n"])

    assert await count() == 48
    await client.post("/api/forecast/refresh")
    assert await count() == 48  # same clock hour: nothing added
    # Only the next 72 hours are archived, and bad percentages are dropped.
    hours = forecast.parse_hourly(
        _entries(_this_hour(), [60.0] * 100, cloud_coverage=140, precipitation_probability="x"),
        "°F",
    )
    assert hours[0].cloud_pct is None and hours[0].precip_pct is None
    now = datetime.now(UTC) + timedelta(days=200)
    far = forecast.parse_hourly(
        _entries(now.replace(minute=0, second=0, microsecond=0), [60.0] * 100), "°F"
    )
    await forecast.save(conn, far, now=now)
    assert await count() == 72  # today's 48 aged out; 72 of the 100 kept


async def test_the_shades_weather_entity_is_used_when_none_is_set_here(client, fake_ha):
    conn = await client.app["scheduler"].get_db()
    await db.set_system_setting(conn, "shades_weather_entity", W)
    fake_ha.forecasts = {W: _entries(_this_hour(), [70])}
    snap = await (await client.put("/api/forecast/settings", json={"enabled": True})).json()
    assert (snap["weather_entity"], snap["shared_with_shades"], snap["state"]) == (W, True, "fresh")


async def test_settings_are_validated_with_fixed_messages(client):
    for body, message in (
        ({"enabled": "yes"}, "enabled must be true or false"),
        ({"weather_entity": "sensor.x"}, "weather_entity must be a weather entity or empty"),
        ({"weather_entity": 5}, "weather_entity must be a weather entity or empty"),
        ({"nope": 1}, "Unknown forecast setting"),
    ):
        resp = await client.put("/api/forecast/settings", json=body)
        assert resp.status == 400, body
        assert (await resp.json())["error"] == message
    resp = await client.put("/api/forecast/settings", json={"weather_entity": None})
    assert (await resp.json())["settings"]["weather_entity"] == ""


async def test_a_refresh_failure_never_escapes_the_job(client, monkeypatch, caplog):
    scheduler = client.app["scheduler"]

    async def boom(*_a, **_k):
        raise RuntimeError("db gone")

    monkeypatch.setattr(scheduler.forecast, "refresh", boom)
    await scheduler.refresh_forecast()
    assert "Could not refresh the forecast" in caplog.text
    job = scheduler._apscheduler.get_job("forecast_refresh")
    assert job.trigger.interval == timedelta(minutes=30)
