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
    # A narrow band: never closer to its far edge than a degree and the deadband.
    assert peak.banked_target("cooling", 70.0, 73.0, 5.0) == 71.0
    assert peak.banked_target("heating", 70.0, 73.0, 5.0) == 72.0
    assert peak.banked_target("cooling", 70.0, 73.0, 5.0, 0.5) == 71.5
    assert peak.banked_target("heating", 70.0, 73.0, 5.0, 0.5) == 71.5
    # Too narrow even for that: the middle of it.
    assert peak.banked_target("cooling", 70.0, 70.5, 2.0) == 70.25
    assert peak.banked_target("heating", 70.0, 72.0, 2.0, 1.5) == 71.0


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
        ({"start": "+1:00"}, peak.BAD_TIME),
        ({"start": " 1:00"}, peak.BAD_TIME),
        ({"start": "１５:00"}, peak.BAD_TIME),
        ({"start": "1２:00"}, peak.BAD_TIME),
        ({"end": "12:60"}, peak.BAD_TIME),
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


T = "climate.peak_zone"


async def _peak_site(client, fake_ha, monkeypatch, rooms, ambient=75.0):
    """A zone of rooms with sensors and vents, a 68–76 house band, and banking due now."""
    from backend import house

    fake_ha.seed_state(
        T,
        "heat_cool",
        {"current_temperature": ambient, "temperature": ambient, "hvac_action": "idle"},
    )
    ids = {}
    for name, temp in rooms.items():
        fake_ha.seed_state(f"sensor.peak_{name}", str(temp), {"unit_of_measurement": "°F"})
        fake_ha.seed_state(f"cover.peak_{name}", "open", {})
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": T})
        ids[name] = (await resp.json())["id"]
        await client.post(
            f"/api/rooms/{ids[name]}/sensors", json={"entity_id": f"sensor.peak_{name}"}
        )
        await client.post(
            f"/api/rooms/{ids[name]}/vents",
            json={"entity_id": f"cover.peak_{name}", "control_method": "open_close"},
        )
    await client.put(f"/api/thermostats/{T}", json={"min_cycle_runtime_min": 15})
    conn = await client.app["scheduler"].get_db()
    await house.set_band(conn, 68.0, 76.0)
    now = tz.to_local(datetime.now(UTC))
    start = now + timedelta(minutes=30)
    resp = await client.put(
        "/api/peak-hours",
        json={
            "enabled": True,
            "start": start.strftime("%H:%M"),
            "end": (start + timedelta(hours=3)).strftime("%H:%M"),
            "days": list(range(7)),
            "lead_min": 60,
        },
    )
    assert resp.status == 200, await resp.text()
    # The engine exists before the first tick, so the outside reading can be set first.
    await client.app["scheduler"]._sync_engines()
    return ids, _hot(client, monkeypatch)


def _hot(client, monkeypatch):
    from unittest.mock import AsyncMock

    engine = client.app["scheduler"]._engines[T]
    monkeypatch.setattr(engine, "_read_outside_temp", AsyncMock(return_value=95.0))
    return engine


async def test_a_real_banking_run_cools_into_the_band_and_ends_by_itself(
    client, fake_ha, tick, monkeypatch
):
    ids, eng = await _peak_site(client, fake_ha, monkeypatch, {"den": 75.5})
    await tick()
    await tick()
    assert eng.cycle_state.value == "running" and eng.cycle_mode == "cooling"
    assert [(ar.source, ar.target_temp) for ar in eng._active_rooms.values()] == [("bank", 74.0)]
    assert eng.bank_rooms == [ids["den"]]
    # It arrives: held for its minimum runtime, then ends as any run does.
    await fake_ha.set_entity_state("sensor.peak_den", "73.9", {"unit_of_measurement": "°F"})
    await tick()
    assert eng._cycle_log.in_min_runtime_hold is True
    eng._cycle_log.started_at -= timedelta(minutes=16)
    await tick()
    await tick()
    assert eng.cycle_state.value == "idle" and eng.bank_rooms == []
    conn = await client.app["scheduler"].get_db()
    async with conn.execute(
        "SELECT ended_reason FROM cycle_logs WHERE thermostat_entity_id = ?", (T,)
    ) as cur:
        reasons = [r["ended_reason"] for r in await cur.fetchall()]
    assert len(reasons) == 1 and not str(reasons[0]).startswith("aborted")


async def test_a_real_banking_run_is_wound_up_cleanly_when_the_peak_begins(
    client, fake_ha, tick, monkeypatch
):
    """Part-way to its banked target when the peak starts: the run ends, it is not aborted."""
    _ids, eng = await _peak_site(client, fake_ha, monkeypatch, {"den": 75.5})
    await tick()
    await tick()
    assert [(ar.source, ar.target_temp) for ar in eng._active_rooms.values()] == [("bank", 74.0)]
    await fake_ha.set_entity_state("sensor.peak_den", "74.9", {"unit_of_measurement": "°F"})
    # The peak begins now, and the run has had its minimum runtime.
    now = tz.to_local(datetime.now(UTC))
    resp = await client.put(
        "/api/peak-hours",
        json={
            "start": (now - timedelta(minutes=1)).strftime("%H:%M"),
            "end": (now + timedelta(hours=2)).strftime("%H:%M"),
        },
    )
    assert resp.status == 200, await resp.text()
    eng._cycle_log.started_at -= timedelta(minutes=16)
    for _ in range(3):
        await tick()
    assert eng.cycle_state.value == "idle"
    conn = await client.app["scheduler"].get_db()
    async with conn.execute(
        "SELECT ended_reason FROM cycle_logs WHERE thermostat_entity_id = ?", (T,)
    ) as cur:
        reasons = [r["ended_reason"] for r in await cur.fetchall()]
    assert len(reasons) == 1 and not str(reasons[0]).startswith("aborted")


@pytest.mark.parametrize("ambient", [60.0, 62.0, 66.0, 70.0, 75.0])
async def test_banking_never_outvotes_a_room_past_a_safety_limit(
    client, fake_ha, tick, monkeypatch, ambient
):
    """Two rooms would be cooled for the peak; a third is too cold. The zone must heat."""
    ids, eng = await _peak_site(
        client, fake_ha, monkeypatch, {"cold": 57.0, "one": 75.5, "two": 75.5}, ambient=ambient
    )
    await client.put(f"/api/house/rooms/{ids['cold']}", json={"in_use": False})
    await tick()
    await tick()
    assert eng.cycle_mode == "heating"
    assert {ar.source for ar in eng._active_rooms.values()} == {"safety"}


@pytest.mark.parametrize("ambient", [60.0, 66.0, 70.0, 73.0, 73.6, 75.0])
async def test_banking_never_outvotes_a_hold(client, fake_ha, tick, monkeypatch, ambient):
    ids, eng = await _peak_site(
        client, fake_ha, monkeypatch, {"held": 70.0, "one": 75.5, "two": 75.5}, ambient=ambient
    )
    await client.post(
        f"/api/rooms/{ids['held']}/override", json={"target_temp": 73, "duration_hours": 2}
    )
    await tick()
    await tick()
    assert eng.cycle_mode == "heating"
    assert [ar.source for ar in eng._active_rooms.values()] == ["override"]


async def test_a_banking_room_past_a_safety_limit_is_still_protected(
    client, fake_ha, tick, monkeypatch
):
    """A band wider than the zone's limits: the room is cooled as a safety room, not a banked one."""
    from backend import house

    _ids, eng = await _peak_site(client, fake_ha, monkeypatch, {"hot": 78.0}, ambient=78.0)
    conn = await client.app["scheduler"].get_db()
    await client.put(f"/api/thermostats/{T}", json={"max_setpoint": 77.0})
    await house.set_band(conn, 64.0, 82.0)
    await tick()
    await tick()
    assert eng.cycle_mode == "cooling"
    assert [ar.source for ar in eng._active_rooms.values()] == ["safety"]
