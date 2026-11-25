"""Rooms following the house band, inside the cycle engine."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from backend import house
from backend.engine.cycle_engine import CycleState

from .test_cycle_engine import _make_engine, _make_ha
from .test_openings_engine import _two_scheduled_rooms

pytestmark = pytest.mark.asyncio


async def _house(temps: dict[str, float | None], *, ambient: float = 71.0):
    conn = await _two_scheduled_rooms()
    await house.set_band(conn, 68.0, 74.0)
    for rid in ("r1", "r2"):
        await house.set_switches(conn, rid, {"use_schedules": False})
    engine = _make_engine(_make_ha(ambient=ambient))
    engine._get_avg_temp = lambda room, **_k: temps[room.id]  # type: ignore[method-assign]
    engine._reset_setpoint_to_ambient = AsyncMock()  # type: ignore[method-assign]
    started = AsyncMock()
    engine._start_or_update_cycle = started  # type: ignore[method-assign]
    engine._monitor_rooms = AsyncMock()  # type: ignore[method-assign]
    return conn, engine, started


def _started(started) -> tuple[dict[str, float], str]:
    assert started.await_args is not None
    active, mode = started.await_args.args[1], started.await_args.args[2]
    return {rid: ar.target_temp for rid, ar in active.items()}, mode


async def test_a_room_below_the_band_is_heated_to_heat_to_and_one_inside_is_left_alone():
    conn, engine, started = await _house({"r1": 65.0, "r2": 71.0})
    await engine._do_tick(conn)
    assert _started(started) == ({"r1": 68.0}, "heating")
    await conn.close()


async def test_a_room_above_the_band_is_cooled_to_cool_to():
    conn, engine, started = await _house({"r1": 77.0, "r2": 71.0})
    await engine._do_tick(conn)
    assert _started(started) == ({"r1": 74.0}, "cooling")
    await conn.close()


async def test_rooms_inside_the_band_start_nothing():
    conn, engine, started = await _house({"r1": 69.0, "r2": 73.5})
    await engine._do_tick(conn)
    started.assert_not_awaited()
    engine._reset_setpoint_to_ambient.assert_awaited()
    await conn.close()


async def test_a_room_just_inside_an_edge_does_not_start_a_cycle():
    """The deadband applies at each edge, as it does around a single target."""
    conn, engine, started = await _house({"r1": 67.9, "r2": 74.1})
    await engine._do_tick(conn)
    started.assert_not_awaited()
    await conn.close()


async def test_a_running_cycle_works_every_banded_room_to_its_own_edge():
    conn, engine, _started_mock = await _house({"r1": 65.0, "r2": 71.0})
    from backend.engine.room_manager import get_active_rooms

    active = {ar.room.id: ar for ar in await get_active_rooms(conn, engine.thermostat_entity_id)}
    engine._apply_bands(active, "heating", None)
    assert {rid: ar.target_temp for rid, ar in active.items()} == {"r1": 68.0, "r2": 68.0}
    engine._apply_bands(active, "cooling", None)
    assert {rid: ar.target_temp for rid, ar in active.items()} == {"r1": 74.0, "r2": 74.0}
    await conn.close()


async def test_with_no_reading_the_thermostat_stands_in_then_heat_to():
    conn, engine, _s = await _house({"r1": None, "r2": None})
    from backend.engine.room_manager import get_active_rooms

    active = {ar.room.id: ar for ar in await get_active_rooms(conn, engine.thermostat_entity_id)}
    state = {"attributes": {"current_temperature": 80.0}}
    engine._apply_bands(active, None, state)
    assert active["r1"].target_temp == 74.0  # the thermostat reads above the band
    engine._apply_bands(active, None, None)
    assert active["r1"].target_temp == 68.0
    assert engine._state == CycleState.IDLE
    await conn.close()


async def test_single_target_rooms_are_untouched():
    conn = await _two_scheduled_rooms()  # schedules at 72, no house band
    engine = _make_engine(_make_ha(ambient=72.0))
    from backend.engine.room_manager import get_active_rooms

    active = {ar.room.id: ar for ar in await get_active_rooms(conn, engine.thermostat_entity_id)}
    engine._apply_bands(active, "heating", None)
    assert {ar.target_temp for ar in active.values()} == {72.0}
    await conn.close()


async def test_a_restored_cycle_gets_its_band_back():
    """The band is not in the cycle snapshot; restore re-reads the house band."""
    import json

    from backend import db
    from backend.models import CycleLog

    from .test_cycle_engine import THERMO_ID, _make_tc

    conn, _engine, _s = await _house({"r1": 65.0, "r2": 71.0})
    await db.upsert_thermostat_config(conn, _make_tc())
    rooms_json = json.dumps(
        {
            "r1": {"name": "Bunk Room", "target": 68.0, "source": "house"},
            "r2": {"name": "Craft Room", "target": 68.0, "source": "house"},
        }
    )
    await db.insert_cycle_log(
        conn, CycleLog.create(thermostat_entity_id=THERMO_ID, mode="heating", rooms_json=rooms_json)
    )
    engine = _make_engine(_make_ha(ambient=64.0))
    await engine.restore_from_db(conn)
    assert engine._state == CycleState.RUNNING
    assert (engine._active_rooms["r1"].heat_to, engine._active_rooms["r1"].cool_to) == (68.0, 74.0)

    # The band was turned off while the server was down: the room keeps its target.
    await house.set_band(conn, None, None)
    engine = _make_engine(_make_ha(ambient=64.0))
    await engine.restore_from_db(conn)
    assert engine._active_rooms["r1"].heat_to is None
    assert engine._active_rooms["r1"].target_temp == 68.0
    await conn.close()
