"""Early Cooling: when a warm afternoon calls for it, and which rooms are cooled early."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from backend import coasting, db, early_cooling, forecast, learning, room_model, tz
from backend.engine.cycle_engine import OPTIONAL_SOURCES, CycleState
from backend.engine.room_manager import ActiveRoom
from backend.models import Room

from .test_coasting import _model
from .test_cycle_engine import _make_engine, _make_ha
from .test_heat_pump import THERMO_ID, _conn

NOW = datetime(2026, 7, 6, 15, 0, tzinfo=UTC)


def _hours(*temps: float) -> list[tuple[datetime, float]]:
    """A forecast: one temperature an hour, starting now."""
    return [(NOW + timedelta(hours=n), temp) for n, temp in enumerate(temps)]


def test_only_a_day_still_warming_past_the_cool_to_counts():
    # 84 °F now, 92 °F within three hours, a Cool To of 76.
    assert early_cooling.warming(84.0, _hours(84, 88, 92, 90), NOW, 76.0) == 92.0
    # Shifted to agree with the sensor, as the outlook is.
    assert early_cooling.warming(86.0, _hours(84, 88, 92, 90), NOW, 76.0) == 94.0
    # Hours past the look-ahead are not counted.
    assert early_cooling.warming(84.0, _hours(84, 85, 85, 85, 99), NOW, 76.0) is None
    # A day that has peaked, one that stays under the Cool To, and no forecast.
    assert early_cooling.warming(92.0, _hours(92, 91, 88, 84), NOW, 76.0) is None
    assert early_cooling.warming(60.0, _hours(60, 66, 72, 74), NOW, 76.0) is None
    assert early_cooling.warming(84.0, [], NOW, 76.0) is None
    assert early_cooling.warming(84.0, _hours(84), NOW, 76.0) is None


def test_a_breach_is_the_room_passing_its_cool_to_when_left_alone():
    outlook = coasting.Outlook(NOW, 90.0, _hours(90, 94, 96, 96))
    # Losing 0.1 of the difference an hour: from 74.5 °F it passes 76 in about an hour.
    found = early_cooling.breach_in(_model(loss=0.1), temp=74.5, cool_to=76.0, outlook=outlook)
    assert found is not None and 45 <= found <= 75
    # A tight room does not get there in three hours.
    assert (
        early_cooling.breach_in(_model(loss=0.01), temp=74.0, cool_to=76.0, outlook=outlook) is None
    )
    # Already there.
    assert early_cooling.breach_in(_model(), temp=76.0, cool_to=76.0, outlook=outlook) == 0


async def _setup(monkeypatch, *, temp=75.4, outside=90.0, level="on", mode="cool"):
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)
    conn = await _conn()
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    await learning.update_settings(conn, {"early_cool_level": early_cooling.LEVELS.index(level)})
    await forecast.update_settings(conn, {"correct": False})
    for at, value in _hours(90, 94, 96, 96):
        await conn.execute(
            "INSERT INTO forecast_hours(at, temp, fetched_at) VALUES(?, ?, 0)",
            (int(at.timestamp()), int(value * forecast.TEMP_SCALE)),
        )
    await conn.commit()
    engine = _make_engine(_make_ha(ambient=temp, hvac_mode=mode, hvac_action="idle"))
    temps = {"now": temp}
    engine._get_avg_temp = lambda _room, **_k: temps["now"]
    engine._read_outside_temp = AsyncMock(return_value=outside)
    engine._logger = AsyncMock()
    models = {room.id: _model(loss=0.1, fitted=NOW)}
    monkeypatch.setattr(room_model, "load", AsyncMock(return_value=models))
    band = [ActiveRoom(room=room, target_temp=68.0, source="house", heat_to=68.0, cool_to=76.0)]
    return conn, engine, room, band, temps, models


def _targets(active) -> list[tuple[float, str]]:
    return [(ar.target_temp, ar.source) for ar in active]


def _said(engine) -> list[str]:
    return [c.args[2] for c in engine._logger.log.await_args_list]


@pytest.mark.asyncio
async def test_a_banded_room_about_to_pass_its_cool_to_is_cooled_a_little_now(monkeypatch):
    conn, engine, room, band, temps, _models = await _setup(monkeypatch)
    assert "precool" in OPTIONAL_SOURCES
    # 75.4 °F in a 68 to 76 band, 90 °F and rising: cooled 1.5 °F in, to 74.5.
    assert _targets(await engine._cool_early(conn, band, now=NOW)) == [(74.5, "precool")]
    assert engine._optional_replaced == {room.id: band[0]} and engine.early_cool_rooms == []
    assert len(_said(engine)) == 1 and _said(engine)[0].startswith(
        "Cooling Bunk Room early to 74.5°F: left alone it is expected to pass 76°F in about"
    )
    # Said once for an afternoon, and again once three hours have gone by.
    await engine._cool_early(conn, band, now=NOW + timedelta(minutes=1))
    assert len(_said(engine)) == 1
    engine._early_cool_logged = {k: NOW - timedelta(hours=4) for k in engine._early_cool_logged}
    await engine._cool_early(conn, band, now=NOW)
    assert len(_said(engine)) == 2
    # Cool enough already; and past its Cool To the band itself is asking.
    for reading in (74.9, 76.8):
        temps["now"] = reading
        assert await engine._cool_early(conn, band, now=NOW) == band
    # A room's own deadband and the zone's limits are kept.
    temps["now"] = 75.4
    tc = await db.get_thermostat_config(conn, THERMO_ID)
    tc.min_setpoint = 75.0
    await db.upsert_thermostat_config(conn, tc)
    wide = [
        ActiveRoom(
            room=room,
            target_temp=68.0,
            source="schedule",
            heat_to=68.0,
            cool_to=76.0,
            deadband_override=0.2,
        )
    ]
    asked = await engine._cool_early(conn, wide, now=NOW)
    assert _targets(asked) == [(75.0, "precool")] and asked[0].deadband_override == 0.2
    await conn.close()


@pytest.mark.asyncio
async def test_what_is_never_cooled_early(monkeypatch):
    conn, engine, room, band, temps, models = await _setup(monkeypatch)
    # A hold, a single target, and a room with no reading.
    hold = ActiveRoom(room=room, target_temp=72.0, source="override", heat_to=72.0, cool_to=76.0)
    single = ActiveRoom(room=room, target_temp=72.0, source="schedule")
    assert await engine._cool_early(conn, [hold, single], now=NOW) == [hold, single]
    temps["now"] = None
    assert await engine._cool_early(conn, band, now=NOW) == band
    temps["now"] = 75.4
    # No outside reading, no model, a stale one, and a tight room that will not get there.
    engine._read_outside_temp = AsyncMock(return_value=None)
    assert await engine._cool_early(conn, band, now=NOW) == band
    engine._read_outside_temp = AsyncMock(return_value=90.0)
    kept = models.pop(room.id)
    assert await engine._cool_early(conn, band, now=NOW) == band
    models[room.id] = _model(loss=0.1, fitted=NOW - timedelta(days=30))
    assert await engine._cool_early(conn, band, now=NOW) == band
    models[room.id] = _model(loss=0.01, fitted=NOW)
    assert await engine._cool_early(conn, band, now=NOW) == band
    models[room.id] = kept
    # A thermostat in heat mode, and a building held to heating (one only watched is not).
    engine._ha.get_state.return_value = {"state": "heat", "attributes": {}}
    assert await engine._cool_early(conn, band, now=NOW) == band
    engine._ha.get_state.return_value = {"state": "cool", "attributes": {}}
    engine._get_building_side = lambda: ("heating", True)
    assert await engine._cool_early(conn, band, now=NOW) == band
    engine._get_building_side = lambda: ("heating", False)
    assert len(await engine._cool_early(conn, band, now=NOW)) == 1
    engine._get_building_side = lambda: ("cooling", True)
    assert _targets(await engine._cool_early(conn, band, now=NOW)) == [(74.5, "precool")]
    engine._get_building_side = None
    # A run going the other way; a cooling run may be joined.
    engine._state, engine._cycle_mode = CycleState.RUNNING, "heating"
    assert await engine._cool_early(conn, band, now=NOW) == band
    engine._cycle_mode = "cooling"
    assert _targets(await engine._cool_early(conn, band, now=NOW)) == [(74.5, "precool")]
    engine._state = CycleState.IDLE
    # A day that is not warming: the forecast gone, or corrected with nothing to correct by.
    await forecast.update_settings(conn, {"correct": True})
    assert _targets(await engine._cool_early(conn, band, now=NOW)) == [(74.5, "precool")]
    await conn.execute("DELETE FROM forecast_hours")
    await conn.commit()
    assert await engine._cool_early(conn, band, now=NOW) == band
    await conn.close()


@pytest.mark.asyncio
async def test_watch_only_says_what_it_would_do_and_off_does_nothing(monkeypatch):
    conn, engine, _room, band, _temps, _models = await _setup(monkeypatch, level="watch")
    assert await engine._cool_early(conn, band, now=NOW) == band
    assert _said(engine)[0].startswith("Would cool (watching only) Bunk Room early to 74.5°F")
    assert engine._optional_replaced == {}
    await learning.update_settings(conn, {"early_cool_level": 0})
    assert await engine._cool_early(conn, band, now=NOW) == band
    await learning.update_settings(conn, {"early_cool_level": 2})
    engine._logger = None
    assert await engine._cool_early(conn, band) == band  # the clock's own "now": no forecast
    assert len(await engine._cool_early(conn, band, now=NOW)) == 1
    await conn.close()


@pytest.mark.asyncio
async def test_a_room_that_started_a_run_is_kept_in_it_to_the_end(monkeypatch):
    conn, engine, room, band, temps, _models = await _setup(monkeypatch)
    asked = await engine._cool_early(conn, band, now=NOW)
    engine._state, engine._cycle_mode = CycleState.RUNNING, "cooling"
    engine._active_rooms = {room.id: asked[-1]}
    assert engine.early_cool_rooms == [room.id]
    # Cool now, the afternoon over, even switched off: the run ends by the usual rules.
    temps["now"] = 74.0
    later = NOW + timedelta(hours=6)
    assert _targets(await engine._cool_early(conn, band, now=later)) == [(74.5, "precool")]
    await learning.update_settings(conn, {"early_cool_level": 0})
    assert _targets(await engine._cool_early(conn, band, now=later)) == [(74.5, "precool")]
    # The target is the one asked for, not one Eco has since relaxed.
    engine._active_rooms[room.id].requested_target = 74.0
    assert _targets(await engine._cool_early(conn, band, now=later)) == [(74.0, "precool")]
    # A hold placed meanwhile has the room from here.
    hold = [ActiveRoom(room=room, target_temp=72.0, source="override")]
    assert await engine._cool_early(conn, hold, now=later) == hold
    engine._state = CycleState.IDLE
    assert await engine._cool_early(conn, band, now=later) == band
    await conn.close()
