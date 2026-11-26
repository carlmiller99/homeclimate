"""How far the forecast is usually off, and correcting for it."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import forecast, tz
from backend import forecast_bias as fb

pytestmark = pytest.mark.asyncio

W = "weather.home"
NOW = datetime(2026, 1, 10, 12, 20, tzinfo=UTC)
HOUR = 3600


def _at(hours_ago: int) -> int:
    return int(NOW.timestamp()) // HOUR * HOUR - hours_ago * HOUR


async def _conn(client):
    conn = await client.app["scheduler"].get_db()
    # The recorder's key for the one room these readings belong to.
    await conn.execute(
        "INSERT OR IGNORE INTO room_reading_keys(key, kind, value) VALUES(1, 'room', 'r1')"
    )
    await conn.commit()
    return conn


async def _seed(conn, hours_ago: int, said: float, recorded: float | None, *, lead_h=6, off_s=0):
    """One past hour: what was forecast for it, and what the outside sensor read."""
    at = _at(hours_ago)
    await conn.execute(
        "INSERT OR REPLACE INTO forecast_snapshots(issued, at, temp) VALUES(?,?,?)",
        (at - lead_h * HOUR, at, round(said * 100)),
    )
    if recorded is not None:
        await conn.execute(
            "INSERT OR REPLACE INTO room_readings(room_key, ts, zone_key, action_key,"
            " outside_temp) VALUES(1, ?, 1, 1, ?)",
            (at + off_s, round(recorded * 100)),
        )
    await conn.commit()


async def test_nothing_is_learned_from_nothing(client):
    conn = await _conn(client)
    assert await fb.score(conn, now=NOW) == 0
    bias = await fb.load(conn)
    assert (bias.comparisons, bias.ready, bias.mean_error, bias.mean_abs) == (0, False, None, None)
    assert bias.mean_abs_corrected is None and bias.offset(12) == 0.0
    hours = [forecast.Hour(NOW, 50.0, None, None, "")]
    assert bias.correct(hours) is hours
    assert fb.snapshot(bias, in_use=True) == {
        "comparisons": 0,
        "needed": 48,
        "ready": False,
        "in_use": False,
        "mean_error": None,
        "mean_abs": None,
        "mean_abs_corrected": None,
        "by_hour": [],
    }


async def test_each_finished_hour_is_compared_once(client):
    conn = await _conn(client)
    await _seed(conn, 1, said=50.0, recorded=53.0)
    await _seed(conn, 2, said=50.0, recorded=None)  # no reading: skipped
    await _seed(conn, 3, said=50.0, recorded=52.0, off_s=600)  # a reading 10 minutes off counts
    await _seed(conn, 4, said=50.0, recorded=51.0, off_s=1500)  # 25 minutes off does not
    await _seed(conn, 5, said=50.0, recorded=95.0)  # 45 °F out: a broken sensor
    await _seed(conn, 6, said=50.0, recorded=51.0, lead_h=1)  # only a 1-hour-old forecast
    await _seed(conn, 0, said=50.0, recorded=60.0)  # this hour is not finished
    assert await fb.score(conn, now=NOW) == 2
    bias = await fb.load(conn)
    assert bias.comparisons == 2 and bias.mean_error == 2.5 and bias.mean_abs == 2.5
    # Running it again compares nothing twice.
    assert await fb.score(conn, now=NOW) == 0
    assert await fb.score(conn, now=NOW + timedelta(minutes=30)) == 0
    assert (await fb.load(conn)).comparisons == 2
    # The next hour brings one more.
    await _seed(conn, -1, said=50.0, recorded=51.0)
    await _seed(conn, 0, said=50.0, recorded=60.0)
    assert await fb.score(conn, now=NOW + timedelta(hours=2)) == 2


async def test_the_forecast_nearest_six_hours_ahead_is_the_one_scored(client):
    conn = await _conn(client)
    await _seed(conn, 1, said=40.0, recorded=50.0, lead_h=20)
    await _seed(conn, 1, said=48.0, recorded=50.0, lead_h=7)
    await _seed(conn, 1, said=49.5, recorded=50.0, lead_h=3)
    await fb.score(conn, now=NOW)
    assert (await fb.load(conn)).mean_error == 2.0
    # A forecast from days before says nothing about the six-hour one: not scored.
    await _seed(conn, 0, said=40.0, recorded=50.0, lead_h=70)
    assert await fb.score(conn, now=NOW + timedelta(hours=1)) == 0


async def test_a_source_that_gives_its_hours_on_the_half_hour_is_still_scored(client):
    """India, Newfoundland, Adelaide: local hours fall on UTC half hours."""
    conn = await _conn(client)
    at = _at(1) + 1800
    await conn.execute(
        "INSERT INTO forecast_snapshots(issued, at, temp) VALUES(?,?,?)",
        (_at(7), at, 5000),
    )
    await conn.execute(
        "INSERT INTO room_readings(room_key, ts, zone_key, action_key, outside_temp)"
        " VALUES(1, ?, 1, 1, 5300)",
        (at,),
    )
    await conn.commit()
    assert await fb.score(conn, now=NOW) == 1
    assert (await fb.load(conn)).mean_error == 3.0


async def test_two_runs_at_once_score_each_hour_once(client):
    import asyncio

    conn = await _conn(client)
    for h in range(1, 13):
        await _seed(conn, h, said=50.0, recorded=52.0)
    got = await asyncio.gather(fb.score(conn, now=NOW), fb.score(conn, now=NOW))
    assert sorted(got) == [0, 12]
    assert (await fb.load(conn)).comparisons == 12


async def test_only_the_last_two_days_are_caught_up_and_a_bad_mark_is_ignored(client):
    conn = await _conn(client)
    await _seed(conn, 47, said=50.0, recorded=51.0)
    await _seed(conn, 49, said=50.0, recorded=51.0)  # too long ago
    assert await fb.score(conn, now=NOW) == 1
    # A mark left in the future (the clock went backwards) is waited out, so the
    # hours in between are never scored twice.
    from backend import db

    await db.set_system_setting(conn, fb.SCORED_THROUGH, str(_at(-500)))
    await _seed(conn, 1, said=50.0, recorded=51.0)
    assert await fb.score(conn, now=NOW) == 0
    assert await db.get_system_setting(conn, fb.SCORED_THROUGH, "") == str(_at(-500))
    await db.set_system_setting(conn, fb.SCORED_THROUGH, "junk")
    assert await fb.score(conn, now=NOW) == 2


async def _learn(conn, days: int, error_by_local_hour, *, after: int = 0) -> None:
    """Seed ``days`` days of hours whose forecast was off by a known amount."""
    for d in range(days):
        day_now = NOW + timedelta(days=after + d)
        for h in range(1, 25):
            at = int(day_now.timestamp()) // HOUR * HOUR - h * HOUR
            local = tz.to_local(datetime.fromtimestamp(at, UTC)).hour
            await conn.execute(
                "INSERT OR REPLACE INTO forecast_snapshots(issued, at, temp) VALUES(?,?,?)",
                (at - 6 * HOUR, at, 5000),
            )
            await conn.execute(
                "INSERT OR REPLACE INTO room_readings(room_key, ts, zone_key, action_key,"
                " outside_temp) VALUES(1, ?, 1, 1, ?)",
                (at, round((50.0 + error_by_local_hour(local)) * 100)),
            )
        await conn.commit()
        await fb.score(conn, now=day_now)


async def test_a_forecast_that_is_always_off_is_corrected_after_48_comparisons(client):
    """The plan's test: a deliberately biased forecast."""
    conn = await _conn(client)

    def off(hour: int) -> float:
        return 4.0 if 12 <= hour < 18 else -1.0  # reads 4 °F cold every afternoon

    await _learn(conn, 1, off)
    bias = await fb.load(conn)
    assert (bias.comparisons, bias.ready) == (24, False)
    assert bias.offset(14) == 0.0  # not used yet

    await _learn(conn, 10, off, after=1)
    bias = await fb.load(conn)
    assert bias.ready and bias.comparisons >= 48
    # Each hour's habit shows through, pulled a little toward the overall average.
    assert 2.0 < bias.offset(14) < 4.0
    assert -1.0 < bias.offset(3) < 0.0
    # It was off by 1.75 °F on average; over the hours since correcting began, by less.
    assert bias.mean_abs == pytest.approx(1.75)
    assert bias.mean_abs_corrected < 1.4
    afternoon = next(
        NOW + timedelta(hours=i)
        for i in range(24)
        if tz.to_local(NOW + timedelta(hours=i)).hour == 14
    )
    (fixed,) = bias.correct([forecast.Hour(afternoon, 60.0, 10, 20, "sunny")])
    assert 62.0 < fixed.temp < 64.0
    assert (fixed.cloud_pct, fixed.precip_pct, fixed.condition) == (10, 20, "sunny")


async def test_an_hours_own_average_counts_for_more_the_more_it_has_been_seen(client):
    by_hour = {h: fb.HourBias(3, 2.0, 2.0, 1.0) for h in range(16)}
    by_hour[20] = fb.HourBias(1, -6.0, 6.0, 6.0)
    by_hour[21] = fb.HourBias(40, -6.0, 6.0, 6.0)
    bias = fb.Bias(by_hour)
    assert bias.ready
    overall = bias.mean_error
    assert bias.offset(23) == pytest.approx(overall)  # never seen: the overall average
    assert abs(bias.offset(20) - overall) < 1.0  # one sighting is not a habit
    assert bias.offset(21) < -4.0  # forty are
    assert bias.offset(5) == pytest.approx((3 * 2.0 + 8 * overall) / 11)
    assert bias.mean_abs_corrected is None  # nothing has been corrected yet


async def test_the_correction_is_capped(client):
    """A sensor in the afternoon sun, or one freak day, must not swing the forecast."""
    bias = fb.Bias({h: fb.HourBias(60, 25.0 if h == 15 else -25.0, 25.0, 1.0) for h in range(24)})
    assert bias.offset(15) == 8.0 and bias.offset(3) == -8.0


async def test_an_hours_average_follows_about_its_last_thirty_days(client):
    conn = await _conn(client)
    await _learn(conn, 40, lambda _h: 5.0)
    await _learn(conn, 30, lambda _h: 0.0, after=40)
    bias = await fb.load(conn)
    assert abs(bias.offset(12)) < 2.0  # a month on, the old habit has mostly gone


async def test_the_section_shows_corrected_temperatures_and_how_good_they_are(client, fake_ha):
    fake_ha.seed_state(W, "sunny", {"temperature_unit": "°F"})
    start = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    fake_ha.forecasts = {
        W: [
            {"datetime": (start + timedelta(hours=i)).isoformat(), "temperature": 50}
            for i in range(30)
        ]
    }
    snap = await (
        await client.put("/api/forecast/settings", json={"enabled": True, "weather_entity": W})
    ).json()
    assert snap["accuracy"]["ready"] is False
    assert (snap["hours"][0]["temp"], snap["hours"][0]["temp_raw"]) == (50.0, 50.0)

    conn = await _conn(client)
    await conn.executemany(
        "INSERT INTO forecast_bias(hour_of_day, n, mean_error, mean_abs, mean_abs_corrected,"
        " n_corrected) VALUES(?,3,2.5,2.5,0.5,1)",
        [(h,) for h in range(24)],
    )
    await conn.commit()
    snap = await (await client.get("/api/forecast")).json()
    assert snap["accuracy"] == {
        "comparisons": 72,
        "needed": 48,
        "ready": True,
        "in_use": True,
        "mean_error": 2.5,
        "mean_abs": 2.5,
        "mean_abs_corrected": 0.5,
        "by_hour": [{"hour": h, "n": 3, "offset": 2.5} for h in range(24)],
    }
    assert (snap["hours"][0]["temp"], snap["hours"][0]["temp_raw"]) == (52.5, 50.0)
    assert snap["days"][0]["high"] == 52.5

    # Switched off, the forecast is shown as the source gave it; what was learned is kept.
    snap = await (await client.put("/api/forecast/settings", json={"correct": False})).json()
    assert snap["settings"]["correct"] is False
    assert (snap["hours"][0]["temp"], snap["accuracy"]["in_use"]) == (50.0, False)
    assert snap["accuracy"]["comparisons"] == 72


async def test_a_new_weather_source_starts_learning_again(client, fake_ha):
    conn = await _conn(client)
    await conn.execute("INSERT OR REPLACE INTO forecast_bias VALUES(5, 60, 2.0, 2.0, 1.0, 12)")
    await conn.commit()
    for entity in (W, "weather.other"):
        fake_ha.seed_state(entity, "sunny", {"temperature_unit": "°F"})
    start = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    fake_ha.forecasts = {
        e: [
            {"datetime": (start + timedelta(hours=i)).isoformat(), "temperature": 50}
            for i in range(8)
        ]
        for e in (W, "weather.other")
    }
    await client.put("/api/forecast/settings", json={"enabled": True, "weather_entity": W})
    await conn.execute("INSERT OR REPLACE INTO forecast_bias VALUES(5, 60, 2.0, 2.0, 1.0, 12)")
    await conn.commit()
    snap = await (
        await client.put("/api/forecast/settings", json={"weather_entity": "weather.other"})
    ).json()
    assert snap["accuracy"]["comparisons"] == 0


async def test_the_building_planner_sees_the_corrected_forecast(client, fake_ha, monkeypatch):
    conn = await _conn(client)
    start = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    await forecast.save(
        conn,
        [forecast.Hour(start + timedelta(hours=i), 50.0, None, None, "") for i in range(8)],
        now=datetime.now(UTC),
        source=W,
    )
    await conn.executemany(
        "INSERT INTO forecast_bias VALUES(?, 30, 5.0, 5.0, 1.0, 6)", [(h,) for h in range(24)]
    )
    await conn.commit()
    seen: list[list] = []

    async def plan(_conn, _zones, hours, _band, _now):
        seen.append(hours)
        return []

    scheduler = client.app["scheduler"]
    monkeypatch.setattr(scheduler.building_plan, "plan", plan)
    await scheduler._plan_buildings()
    await client.put("/api/forecast/settings", json={"correct": False})
    await scheduler._plan_buildings()
    assert [hours[0].temp for hours in seen[-2:]] == [55.0, 50.0]
