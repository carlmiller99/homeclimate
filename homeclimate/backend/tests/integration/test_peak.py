"""Peak Hours: the settings, the window, the direction and the banked target."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import db, peak, tz

pytestmark = pytest.mark.asyncio

MON = datetime(2026, 7, 6, 12, 0, tzinfo=UTC)  # a Monday, noon


@pytest.fixture(autouse=True)
def utc(monkeypatch):
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)


async def test_the_window_is_the_peak_being_banked_for_or_under_way_else_the_next():
    s = peak.Settings(enabled=True)  # weekdays 14:00 to 19:00, banking from 12:30
    win = peak.window(s, MON)
    assert (win.bank_from.hour, win.bank_from.minute, win.start.hour, win.end.hour) == (
        12,
        30,
        14,
        19,
    )
    assert not win.banking(MON) and not win.under_way(MON)
    assert win.banking(MON + timedelta(minutes=45))
    assert win.under_way(MON + timedelta(hours=3))
    # After today's peak, tomorrow's.
    assert peak.window(s, MON + timedelta(hours=8)).start.day == 7
    # Friday evening: Monday's.
    assert peak.window(s, MON + timedelta(days=4, hours=8)).start.day == 13
    # A peak that runs past midnight is still under way in the small hours.
    late = peak.Settings(enabled=True, start="22:00", end="02:00", days=(0,))
    win = peak.window(late, MON + timedelta(hours=13))  # Tuesday 01:00
    assert win.under_way(MON + timedelta(hours=13)) and win.end.day == 7


async def test_the_direction_comes_from_the_forecast_for_the_peak_hours():
    win = peak.window(peak.Settings(enabled=True), MON)
    hours = lambda *temps: [(win.start + timedelta(hours=i), t) for i, t in enumerate(temps)]  # noqa: E731
    assert peak.direction(win, 68.0, 76.0, 70.0, hours(88, 92, 90)) == "cooling"
    assert peak.direction(win, 68.0, 76.0, 70.0, hours(40, 44)) == "heating"
    assert peak.direction(win, 68.0, 76.0, 90.0, hours(70, 72)) is None  # mild: nothing to bank
    # Forecast hours outside the peak do not count; with none, the outside reading does.
    before = [(win.start - timedelta(hours=2), 99.0)]
    assert peak.direction(win, 68.0, 76.0, 72.0, before) is None
    assert peak.direction(win, 68.0, 76.0, 90.0, []) == "cooling"
    assert peak.direction(win, 68.0, 76.0, None, []) is None


async def test_the_banked_target_is_always_inside_the_band():
    assert peak.banked_target("cooling", 68.0, 76.0, 2.0) == 74.0
    assert peak.banked_target("heating", 68.0, 76.0, 2.0) == 70.0
    # A narrow band: never closer than a degree to its far edge.
    assert peak.banked_target("cooling", 70.0, 73.0, 5.0) == 71.0
    assert peak.banked_target("heating", 70.0, 73.0, 5.0) == 72.0


async def test_the_settings_are_read_changed_and_checked(client):
    body = await (await client.get("/api/peak-hours")).json()
    assert {k: body[k] for k in ("enabled", "start", "end", "days", "lead_min", "peak_depth")} == {
        "enabled": False,
        "start": "14:00",
        "end": "19:00",
        "days": [0, 1, 2, 3, 4],
        "lead_min": 90,
        "peak_depth": 2.0,
    }
    assert (body["min_depth"], body["max_depth"], body["min_lead_min"], body["max_lead_min"]) == (
        1.0,
        5.0,
        30,
        180,
    )
    assert body["window"]["banking"] is False  # not switched on
    resp = await client.put(
        "/api/peak-hours",
        json={"enabled": True, "start": "15:00", "end": "20:00", "days": [6, 5, 5], "lead_min": 60},
    )
    body = await resp.json()
    assert resp.status == 200
    assert (body["enabled"], body["start"], body["days"], body["lead_min"]) == (
        True,
        "15:00",
        [5, 6],
        60,
    )
    for bad, message in (
        ({"enabled": "yes"}, peak.BAD_ENABLED),
        ({"start": "3pm"}, peak.BAD_TIME),
        ({"start": "25:00"}, peak.BAD_TIME),
        ({"end": "15:00"}, peak.BAD_TIME),  # the same as the start
        ({"end": 1500}, peak.BAD_TIME),
        ({"days": []}, peak.BAD_DAYS),
        ({"days": [7]}, peak.BAD_DAYS),
        ({"days": "weekdays"}, peak.BAD_DAYS),
        ({"days": [True]}, peak.BAD_DAYS),
        ({"lead_min": 10}, peak.BAD_LEAD),
        ({"lead_min": 60.5}, peak.BAD_LEAD),
        ({"lead_min": True}, peak.BAD_LEAD),
        ({"peak_depth": 0.5}, peak.BAD_DEPTH),
        ({"peak_depth": 6}, peak.BAD_DEPTH),
        ({"peak_depth": "2"}, peak.BAD_DEPTH),
        ({"peak_depth": True}, peak.BAD_DEPTH),
        ({"price": 0.3}, peak.UNKNOWN_FIELD),
    ):
        resp = await client.put("/api/peak-hours", json=bad)
        assert (resp.status, (await resp.json())["error"]) == (400, message), bad
    # Nothing was changed by the refused requests.
    assert (await (await client.get("/api/peak-hours")).json())["start"] == "15:00"


async def test_the_depth_is_a_difference_in_the_houses_unit(client):
    scheduler = client.app["scheduler"]
    scheduler._active_unit = "C"
    try:
        body = await (await client.put("/api/peak-hours", json={"peak_depth": 1.5})).json()
        assert body["peak_depth"] == 2.7  # 1.5 °C apart is 2.7 °F, with no 32° offset
    finally:
        scheduler._active_unit = "F"


async def test_no_days_at_all_or_a_damaged_setting_fall_back_safely(client):
    conn = await client.app["scheduler"].get_db()
    assert peak.window(peak.Settings(enabled=True, days=()), MON) is None
    for raw in ("not json", '{"start": "soon"}', "[1]"):
        await db.set_system_setting(conn, peak.SETTING_KEY, raw)
        assert await peak.load(conn) == peak.Settings()
