"""Early Cooling, with real engines and real cycles."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from backend import forecast, house, room_model, tz

from ..test_coasting import _model

pytestmark = pytest.mark.asyncio

T = "climate.ec_zone"


@pytest.fixture(autouse=True)
def utc(monkeypatch):
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)


async def _site(client, fake_ha, monkeypatch, rooms, *, ambient=75.0, level=2):
    """A zone in a 68–76 house band on an afternoon forecast to climb from 90 to 100 °F."""
    fake_ha.seed_state(
        T,
        "heat_cool",
        {"current_temperature": ambient, "temperature": ambient, "hvac_action": "idle"},
    )
    ids = {}
    for name, temp in rooms.items():
        fake_ha.seed_state(f"sensor.ec_{name}", str(temp), {"unit_of_measurement": "°F"})
        fake_ha.seed_state(f"cover.ec_{name}", "open", {})
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": T})
        ids[name] = (await resp.json())["id"]
        await client.post(
            f"/api/rooms/{ids[name]}/sensors", json={"entity_id": f"sensor.ec_{name}"}
        )
        await client.post(
            f"/api/rooms/{ids[name]}/vents",
            json={"entity_id": f"cover.ec_{name}", "control_method": "open_close"},
        )
    await client.put(f"/api/thermostats/{T}", json={"min_cycle_runtime_min": 15})
    resp = await client.put("/api/learning/settings", json={"early_cool_level": level})
    assert resp.status == 200, await resp.text()
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    await house.set_band(conn, 68.0, 76.0)
    await forecast.update_settings(conn, {"correct": False})
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    for n, temp in enumerate((90, 96, 100, 100, 100)):
        await conn.execute(
            "INSERT INTO forecast_hours(at, temp, fetched_at) VALUES(?, ?, 0)",
            (int((now + timedelta(hours=n)).timestamp()), temp * forecast.TEMP_SCALE),
        )
    await conn.commit()
    models = {rid: _model(loss=0.1, fitted=datetime.now(UTC)) for rid in ids.values()}
    monkeypatch.setattr(room_model, "load", AsyncMock(return_value=models))
    await scheduler._sync_engines()
    engine = scheduler._engines[T]
    monkeypatch.setattr(engine, "_read_outside_temp", AsyncMock(return_value=90.0))
    return ids, engine


async def test_the_setting_is_checked_and_off_to_begin_with(client):
    body = await (await client.get("/api/learning")).json()
    assert body["settings"]["early_cool_level"] == 0
    resp = await client.put("/api/learning/settings", json={"early_cool_level": "on"})
    assert resp.status == 400
    assert (await resp.json())["error"] == (
        "early_cool_level must be 0 (off), 1 (watch only) or 2 (on)"
    )


async def test_a_room_is_cooled_into_its_band_and_the_run_ends_by_itself(
    client, fake_ha, tick, monkeypatch
):
    ids, eng = await _site(client, fake_ha, monkeypatch, {"bunk": 75.4})
    await tick()
    await tick()
    assert eng.cycle_mode == "cooling"
    assert [(ar.source, ar.target_temp) for ar in eng._active_rooms.values()] == [("precool", 74.5)]
    status = await (await client.get("/api/status")).json()
    zone = next(z for z in status if z["thermostat_entity_id"] == T)
    assert zone["early_cool_rooms"] == [ids["bunk"]]
    fake_ha.seed_state("sensor.ec_bunk", "74.3", {"unit_of_measurement": "°F"})
    await tick()
    eng._cycle_log.started_at -= timedelta(minutes=16)
    await tick()
    await tick()
    assert eng.cycle_state.value == "idle" and eng.early_cool_rooms == []
    conn = await client.app["scheduler"].get_db()
    async with conn.execute(
        "SELECT ended_reason FROM cycle_logs WHERE thermostat_entity_id = ?", (T,)
    ) as cur:
        reasons = [r["ended_reason"] for r in await cur.fetchall()]
    assert len(reasons) == 1 and not str(reasons[0]).startswith("aborted")


async def test_watching_only_starts_nothing(client, fake_ha, tick, monkeypatch):
    _ids, eng = await _site(client, fake_ha, monkeypatch, {"bunk": 75.4}, level=1)
    await tick()
    await tick()
    assert eng.cycle_state.value == "idle"
    assert all(ar.source == "house" for ar in eng._active_rooms.values())


@pytest.mark.parametrize("ambient", [60.0, 66.0, 70.0, 73.0, 75.0, 78.0])
async def test_early_cooling_never_outvotes_a_hold(client, fake_ha, tick, monkeypatch, ambient):
    """Whatever the thermostat reads, the zone does for the hold what it would with this off."""
    ids, eng = await _site(
        client, fake_ha, monkeypatch, {"held": 66.0, "one": 75.4, "two": 75.4}, ambient=ambient
    )
    await client.post(
        f"/api/rooms/{ids['held']}/override", json={"target_temp": 72, "duration_hours": 2}
    )
    await tick()
    await tick()
    assert eng.cycle_mode != "cooling" and eng.early_cool_rooms == []
    assert all(ar.source != "precool" for ar in eng._active_rooms.values())


async def test_a_hold_that_arrives_mid_run_ends_a_run_for_early_cooling_alone(
    client, fake_ha, tick, monkeypatch
):
    ids, eng = await _site(client, fake_ha, monkeypatch, {"held": 70.0, "bunk": 75.4})
    await tick()
    await tick()
    assert eng.cycle_mode == "cooling" and eng.early_cool_rooms == [ids["bunk"]]
    await client.post(
        f"/api/rooms/{ids['held']}/override", json={"target_temp": 72, "duration_hours": 2}
    )
    eng._cycle_log.started_at -= timedelta(minutes=16)
    await tick()
    await tick()
    await tick()
    assert eng.cycle_mode != "cooling" and eng.early_cool_rooms == []
    assert all(ar.source != "precool" for ar in eng._active_rooms.values())
