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


async def test_a_running_cycle_keeps_its_rooms_and_leaves_resting_ones_out():
    conn, engine, _started_mock = await _house({"r1": 68.4, "r2": 71.0})
    from backend.engine.room_manager import get_active_rooms

    async def fresh() -> dict:
        return {ar.room.id: ar for ar in await get_active_rooms(conn, engine.thermostat_entity_id)}

    # r1 is in the running heating cycle and now just past heat-to: it stays,
    # still working to heat-to, so it can finish with its overshoot. r2 is
    # resting inside the band and is not pulled in.
    engine._active_rooms = {"r1": (await fresh())["r1"]}
    active = await fresh()
    engine._apply_bands(active, "heating")
    assert {rid: ar.target_temp for rid, ar in active.items()} == {"r1": 68.0}

    # Nothing is in a cooling cycle yet, and neither room is above cool-to.
    engine._active_rooms = {}
    active = await fresh()
    engine._apply_bands(active, "cooling")
    assert active == {}
    await conn.close()


async def test_a_room_with_no_reading_of_its_own_does_not_follow_the_band():
    """Its place in the band is unknown, and a cycle begun on the thermostat's
    reading could never be judged finished."""
    conn, engine, started = await _house({"r1": None, "r2": None}, ambient=60.0)
    await engine._do_tick(conn)
    started.assert_not_awaited()

    from backend.engine.room_manager import get_active_rooms

    async def fresh() -> dict:
        return {ar.room.id: ar for ar in await get_active_rooms(conn, engine.thermostat_entity_id)}

    for mode in (None, "heating", "cooling"):
        active = await fresh()
        engine._apply_bands(active, mode)
        assert active == {}, mode
    # A room already in the running cycle whose sensor drops out stays in it.
    engine._active_rooms = {"r1": (await fresh())["r1"]}
    active = await fresh()
    engine._apply_bands(active, "heating")
    assert {rid: ar.target_temp for rid, ar in active.items()} == {"r1": 68.0}
    await conn.close()


async def test_safety_limits_still_protect_a_room_resting_inside_a_wide_band():
    """Band 50–90 against limits of 60/85: at 55 or 88 the room is in its band
    and asks for nothing, so the safety limits must step in."""
    for temp, expected in ((55.0, "heating"), (88.0, "cooling")):
        # The thermostat reads what the room does, so the mode check agrees.
        conn, engine, started = await _house({"r1": temp, "r2": 72.0}, ambient=temp)
        await house.set_band(conn, 50.0, 90.0)
        await engine._do_tick(conn)
        targets, mode = _started(started)
        assert mode == expected, temp
        assert set(targets) == {"r1"}
        active = started.await_args.args[1]
        assert active["r1"].source == "safety"
        await conn.close()


async def test_a_full_cycle_heats_to_heat_to_and_then_rests_without_flipping_to_cooling():
    """Nothing mocked inside the engine: start, run, finish, stay idle."""
    import aiosqlite

    from backend import db
    from backend.engine.cycle_engine import CycleEngine
    from backend.engine.vent_controller import VentController
    from backend.models import Room, RoomVent

    from .test_cycle_engine import THERMO_ID, _make_tc

    class Log:
        def __init__(self) -> None:
            self.rows: list[str] = []

        async def log(self, _level, _cat, msg, _details=None) -> None:
            self.rows.append(msg)

    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row
    await db.init_db(conn)
    await db.upsert_thermostat_config(conn, _make_tc())
    for rid in ("r1", "r2", "r3"):
        room = Room.create(name=rid.upper(), thermostat_entity_id=THERMO_ID)
        room.id = rid
        await db.upsert_room(conn, room)
        await db.add_room_vent(conn, RoomVent.create(room_id=rid, entity_id=f"cover.{rid}"))
    await house.set_band(conn, 68.0, 74.0)
    ha = _make_ha(ambient=70.0, hvac_mode="heat", hvac_action="idle")
    log = Log()
    engine = CycleEngine(
        THERMO_ID, ha, VentController(ha), event_logger=log, get_enabled=lambda: True
    )
    # r1 is cold; r2 rests mid-band; r3 hovers just above heat-to all cycle long.
    temps = {"r1": 66.0, "r2": 71.0, "r3": 68.4}
    engine._get_avg_temp = lambda room, **_k: temps[room.id]

    for step in range(6):
        await engine._do_tick(conn)
        assert engine._state == CycleState.RUNNING, step
        assert engine._cycle_mode == "heating"
        assert {r: ar.target_temp for r, ar in engine._active_rooms.items()} == {"r1": 68.0}
        temps["r1"] += 0.3
        temps["r3"] = 68.6 if step % 2 else 68.4
    temps["r1"] = 68.1
    for _ in range(6):
        await engine._do_tick(conn)
    assert engine._state == CycleState.IDLE
    temps["r1"] = 69.5  # it coasts up a little after the cycle
    for _ in range(3):
        await engine._do_tick(conn)
        assert engine._state == CycleState.IDLE  # 69.5 is inside the band: no cooling
    # The rooms resting in the band never joined, and were not logged as excluded.
    joined = [m for m in log.rows if "added to running cycle" in m or "Excluding room" in m]
    assert joined == []
    await conn.close()


async def test_single_target_rooms_are_untouched():
    conn = await _two_scheduled_rooms()  # schedules at 72, no house band
    engine = _make_engine(_make_ha(ambient=72.0))
    from backend.engine.room_manager import get_active_rooms

    active = {ar.room.id: ar for ar in await get_active_rooms(conn, engine.thermostat_entity_id)}
    engine._apply_bands(active, "heating")
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


async def test_heat_pump_early_warm_ups_respect_the_room_switches_and_outrank_the_band():
    from datetime import UTC, datetime, time, timedelta
    from types import SimpleNamespace

    from backend import db
    from backend.models import Schedule

    conn, engine, _s = await _house({"r1": 60.0, "r2": 60.0})
    soon = (datetime.now(UTC) + timedelta(minutes=30)).astimezone().time().replace(microsecond=0)
    for rid in ("r1", "r2"):
        for sched in await db.get_schedules_for_room(conn, rid):
            await db.delete_schedule(conn, sched.id)
        await db.upsert_schedule(
            conn,
            Schedule.create(
                room_id=rid,
                days_of_week=list(range(7)),
                start_time=soon,
                end_time=time(23, 59),
                target_temp=72.0,
            ),
        )
    engine._heat_pump = lambda: SimpleNamespace(avoid_aux=True, recovery_f_per_hr=2.0)
    engine._hp_strips = False
    engine._ha.get_state = lambda _eid: {"state": "heat", "attributes": {}}
    from backend.engine.room_manager import get_active_rooms

    async def warmed() -> dict:
        active = await get_active_rooms(conn, engine.thermostat_entity_id)
        out = await engine._heat_pump_warmups(conn, active)
        return {ar.room.id: (ar.source, ar.target_temp) for ar in out}

    # Schedules are switched off for both rooms (the fixture): nothing is warmed
    # early, and both simply follow the house band.
    assert await warmed() == {"r1": ("house", 68.0), "r2": ("house", 68.0)}
    # With its schedules back on, r1's coming block takes over from the band.
    await house.set_switches(conn, "r1", {"use_schedules": True})
    assert await warmed() == {"r1": ("schedule", 72.0), "r2": ("house", 68.0)}
    # A room not in use is never warmed early.
    await house.set_switches(conn, "r1", {"in_use": False})
    assert await warmed() == {"r2": ("house", 68.0)}
    await conn.close()
