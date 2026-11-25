"""A zone held to its building's side, inside the cycle engine."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from backend import house

from .test_house_engine import _house, _started

pytestmark = pytest.mark.asyncio


async def _zone(temps, side, obey=True, *, ambient=71.0):
    conn, engine, started = await _house(temps, ambient=ambient)
    engine._get_building_side = lambda: (side, obey)
    engine._logger = AsyncMock()
    return conn, engine, started


def _messages(engine) -> list[str]:
    return [c.args[2] for c in engine._logger.log.await_args_list]


async def test_a_zone_wanting_the_other_side_waits_and_says_so_once():
    conn, engine, started = await _zone({"r1": 77.0, "r2": 71.0}, "heating", ambient=77.0)
    for _ in range(3):
        await engine._do_tick(conn)
    started.assert_not_awaited()
    engine._reset_setpoint_to_ambient.assert_awaited()
    wait = engine.building_wait
    assert (wait["direction"], wait["obeyed"], wait["excess"]) == ("cooling", True, 3.0)
    assert _messages(engine) == [
        f"{engine.thermostat_entity_id} is waiting to start cooling: its building is on heating"
    ]
    # The building switches: the cycle starts and the wait is over.
    engine._get_building_side = lambda: ("cooling", True)
    await engine._do_tick(conn)
    assert _started(started) == ({"r1": 74.0}, "cooling")
    assert engine.building_wait is None
    await conn.close()


async def test_rooms_that_need_the_buildings_side_are_still_served():
    """One room too warm, one too cold, building on heating: heat the cold one."""
    conn, engine, started = await _zone({"r1": 77.0, "r2": 65.0}, "heating", ambient=77.0)
    await engine._do_tick(conn)
    targets, mode = _started(started)
    assert mode == "heating" and set(targets) == {"r2"}
    assert engine.building_wait["direction"] == "cooling"
    await conn.close()


async def test_watching_only_records_the_wait_and_holds_nothing():
    conn, engine, started = await _zone({"r1": 77.0, "r2": 71.0}, "heating", False, ambient=77.0)
    await engine._do_tick(conn)
    assert _started(started) == ({"r1": 74.0}, "cooling")
    assert engine.building_wait["obeyed"] is False
    assert _messages(engine) == [
        f"{engine.thermostat_entity_id} would wait (watching only) to start cooling:"
        " its building is on heating"
    ]
    await conn.close()


async def test_the_same_side_or_no_side_holds_nothing():
    for side in ("cooling", None):
        conn, engine, started = await _zone({"r1": 77.0, "r2": 71.0}, side, ambient=77.0)
        await engine._do_tick(conn)
        assert _started(started)[1] == "cooling"
        assert engine.building_wait is None
        await conn.close()


async def test_a_building_that_is_off_asks_for_nothing_but_safety_still_acts():
    conn, engine, started = await _zone({"r1": 65.0, "r2": 71.0}, "off")
    await engine._do_tick(conn)
    started.assert_not_awaited()
    await conn.close()
    # Watching an "off" would be meaningless: it only applies when obeyed.
    conn, engine, started = await _zone({"r1": 65.0, "r2": 71.0}, "off", False)
    await engine._do_tick(conn)
    assert _started(started)[1] == "heating"
    await conn.close()
    # 50 °F is below the 60 °F safety floor: heated even with the building off.
    conn, engine, started = await _zone({"r1": 50.0, "r2": 71.0}, "off", ambient=50.0)
    await engine._do_tick(conn)
    active = started.await_args.args[1]
    assert {rid: ar.source for rid, ar in active.items()} == {"r1": "safety"}
    await conn.close()


async def test_a_safety_breach_is_never_held_to_a_side():
    """88 °F is past the 85 °F ceiling: cooled even with the building on heating."""
    conn, engine, started = await _zone({"r1": 88.0, "r2": 72.0}, "heating", ambient=88.0)
    await house.set_band(conn, 50.0, 90.0)
    await engine._do_tick(conn)
    assert _started(started)[1] == "cooling"
    assert engine.building_wait is None
    await conn.close()


async def test_a_room_with_no_reading_adds_nothing_to_how_far_out_the_zone_is():
    conn, engine, started = await _zone({"r1": 77.0, "r2": 71.0}, "heating", ambient=77.0)
    await engine._do_tick(conn)
    assert engine.building_wait["excess"] == 3.0
    temps = {"r1": None, "r2": None}
    engine._get_avg_temp = lambda room, **_k: temps[room.id]
    from backend.engine.room_manager import get_active_rooms

    active = {ar.room.id: ar for ar in await get_active_rooms(conn, engine.thermostat_entity_id)}
    tc = await engine._load_tc(conn)
    await engine._keep_to_building_side("cooling", "heating", True, active, tc, None, None, None)
    assert engine.building_wait["excess"] == 0.0
    await conn.close()
