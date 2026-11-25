"""Rooms whose schedule, hold or occupancy target is a band, inside the cycle engine."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from backend import db, house
from backend.models import RoomOverride

from .test_cycle_engine import _make_engine, _make_ha
from .test_house_engine import _started
from .test_openings_engine import _two_scheduled_rooms

pytestmark = pytest.mark.asyncio


async def _banded(temps, *, ambient=71.0):
    """Two rooms on an all-day schedule; r1's is a 68–74 °F band, r2's a single 72 °F."""
    conn = await _two_scheduled_rooms()
    (block,) = await db.get_schedules_for_room(conn, "r1")
    block.target_temp = 68.0
    await db.upsert_schedule(conn, block)
    await house.set_target_band(conn, "schedule", block.id, 68.0, 74.0)
    engine = _make_engine(_make_ha(ambient=ambient))
    engine._get_avg_temp = lambda room, **_k: temps[room.id]
    engine._reset_setpoint_to_ambient = AsyncMock()
    started = AsyncMock()
    engine._start_or_update_cycle = started
    engine._monitor_rooms = AsyncMock()
    return conn, engine, started


async def test_a_room_resting_inside_its_schedules_band_asks_for_nothing():
    conn, engine, started = await _banded({"r1": 71.0, "r2": 72.0})
    await engine._do_tick(conn)
    started.assert_not_awaited()
    await conn.close()


async def test_below_the_band_it_is_heated_to_heat_to_and_above_cooled_to_cool_to():
    conn, engine, started = await _banded({"r1": 65.0, "r2": 72.0})
    await engine._do_tick(conn)
    targets, mode = _started(started)
    assert (targets["r1"], mode) == (68.0, "heating")
    await conn.close()
    conn, engine, started = await _banded({"r1": 77.0, "r2": 72.0}, ambient=77.0)
    await engine._do_tick(conn)
    targets, mode = _started(started)
    assert (targets["r1"], mode) == (74.0, "cooling")
    await conn.close()


async def test_a_banded_room_past_a_safety_limit_is_protected_like_any_other():
    conn, engine, started = await _banded({"r1": 50.0, "r2": 72.0}, ambient=50.0)
    await engine._do_tick(conn)
    active = started.await_args.args[1]
    assert active["r1"].source == "safety"
    await conn.close()


async def test_a_hold_with_a_band_holds_the_room_between_its_edges():
    temps = {"r1": 70.0, "r2": 72.0}
    conn, engine, started = await _banded(temps)
    expires = datetime.now(UTC) + timedelta(hours=2)
    await db.set_room_override(conn, RoomOverride("r1", 66.0, expires))
    await house.set_target_band(conn, "hold", "r1", 66.0, 69.0, house.hold_stamp(expires))
    await engine._do_tick(conn)
    targets, mode = _started(started)
    assert (targets["r1"], mode) == (69.0, "cooling")
    assert started.await_args.args[1]["r1"].source == "override"
    await conn.close()


async def test_with_no_reading_of_its_own_a_banded_hold_goes_by_the_thermostat():
    """A sensor dropping out must not turn an explicit hold into nothing."""
    temps = {"r1": None, "r2": None}  # no room sensor in the zone is reporting
    conn, engine, started = await _banded(temps, ambient=78.0)
    expires = datetime.now(UTC) + timedelta(hours=2)
    await db.set_room_override(conn, RoomOverride("r1", 68.0, expires))
    await house.set_target_band(conn, "hold", "r1", 68.0, 72.0, house.hold_stamp(expires))
    await engine._do_tick(conn)
    targets, mode = _started(started)
    assert (targets["r1"], mode) == (72.0, "cooling")
    await conn.close()
    # Home Assistant in °C: the thermostat's 26 °C is 78.8 °F, still above the band.
    conn, engine, started = await _banded(temps, ambient=26.0)
    engine._ha.ha_temp_unit = "C"
    await db.set_room_override(conn, RoomOverride("r1", 68.0, expires))
    await house.set_target_band(conn, "hold", "r1", 68.0, 72.0, house.hold_stamp(expires))
    await engine._do_tick(conn)
    targets, mode = _started(started)
    assert (targets["r1"], mode) == (72.0, "cooling")
    await conn.close()
    # The room's offset counts on the stand-in reading, as it does for a single target:
    # 71 °F at the thermostat, +3 °F, is past a 72 °F cool-to; without the offset it is not.
    from backend.engine.room_manager import ActiveRoom

    conn, engine, _started_mock = await _banded(temps, ambient=71.0)
    room = await db.get_room(conn, "r1")
    state = engine._ha.get_state(engine.thermostat_entity_id)
    for offset, joins in ((3.0, True), (0.0, False)):
        room.temp_offset = offset
        rooms = {"r1": ActiveRoom(room, 68.0, "override", heat_to=68.0, cool_to=72.0)}
        engine._apply_bands(rooms, "cooling", state)
        assert ("r1" in rooms) is joins
    # With no thermostat reading either, there is nothing to go by.
    rooms = {"r1": ActiveRoom(room, 68.0, "override", heat_to=68.0, cool_to=72.0)}
    engine._apply_bands(rooms, "cooling", None)
    assert rooms == {}
    await conn.close()
    # A room following the house band still sits out: nobody asked for it by name.
    conn, engine, started = await _banded({"r1": None, "r2": None}, ambient=78.0)
    for sched in await db.get_schedules_for_room(conn, "r1"):
        await db.delete_schedule(conn, sched.id)
    for sched in await db.get_schedules_for_room(conn, "r2"):
        await db.delete_schedule(conn, sched.id)
    await house.set_band(conn, 68.0, 72.0)
    await engine._do_tick(conn)
    started.assert_not_awaited()
    await conn.close()


async def test_a_restart_re_reads_the_band_of_a_running_cycle():
    import json

    from backend.models import CycleLog

    conn, _engine, _s = await _banded({"r1": 77.0, "r2": 72.0})
    rooms_json = json.dumps({"r1": {"name": "Bunk Room", "target": 74.0, "source": "schedule"}})
    await db.insert_cycle_log(
        conn,
        CycleLog.create(
            thermostat_entity_id=_engine.thermostat_entity_id, mode="cooling", rooms_json=rooms_json
        ),
    )
    engine = _make_engine(_make_ha(ambient=80.0))  # consistent with cooling: restored
    await engine.restore_from_db(conn)
    restored = engine._active_rooms["r1"]
    assert (restored.source, restored.heat_to, restored.cool_to) == ("schedule", 68.0, 74.0)
    await conn.close()
