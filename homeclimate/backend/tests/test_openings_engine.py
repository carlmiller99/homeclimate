"""Door and window pausing inside the cycle engine (Smart Control)."""

from __future__ import annotations

from datetime import time
from unittest.mock import AsyncMock

import pytest

from backend import db
from backend.engine.cycle_engine import CycleState
from backend.models import Room, Schedule

from .test_cycle_engine import THERMO_ID, _make_engine, _make_ha, _setup_engine_with_running_cycle

pytestmark = pytest.mark.asyncio


async def test_zone_pause_aborts_a_running_cycle_with_its_own_reason():
    engine, conn, cycle = await _setup_engine_with_running_cycle()
    engine._get_openings = lambda: (True, frozenset())

    await engine._do_tick(conn)

    assert engine.cycle_state == CycleState.IDLE
    stored = await db.get_cycle_log(conn, cycle.id)
    assert stored is not None
    assert stored.ended_reason == "aborted: door or window open"
    await conn.close()


async def _two_scheduled_rooms():
    import aiosqlite

    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row
    await db.init_db(conn)
    for rid, name in (("r1", "Bunk Room"), ("r2", "Craft Room")):
        room = Room.create(name=name, thermostat_entity_id=THERMO_ID)
        room.id = rid
        await db.upsert_room(conn, room)
        await db.upsert_schedule(
            conn,
            Schedule.create(
                room_id=rid,
                days_of_week=list(range(7)),
                start_time=time(0, 0),
                end_time=time(23, 59),
                target_temp=72.0,
            ),
        )
    return conn


async def test_room_pause_removes_only_that_room_from_demand():
    conn = await _two_scheduled_rooms()
    engine = _make_engine(_make_ha(ambient=72.0))
    engine._get_openings = lambda: (False, frozenset({"r1"}))
    engine._infer_mode_from_room_temps = AsyncMock(return_value="off")
    engine._reset_setpoint_to_ambient = AsyncMock()

    await engine._do_tick(conn)

    active = engine._infer_mode_from_room_temps.await_args.args[0]
    assert set(active) == {"r2"}
    await conn.close()


async def test_no_pause_keeps_every_room():
    conn = await _two_scheduled_rooms()
    engine = _make_engine(_make_ha(ambient=72.0))
    engine._get_openings = lambda: (False, frozenset())
    engine._infer_mode_from_room_temps = AsyncMock(return_value="off")
    engine._reset_setpoint_to_ambient = AsyncMock()

    await engine._do_tick(conn)

    assert set(engine._infer_mode_from_room_temps.await_args.args[0]) == {"r1", "r2"}
    await conn.close()
