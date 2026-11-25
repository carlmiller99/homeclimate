"""A zone held to its building's side, inside the cycle engine."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from backend import house

from .test_cycle_engine import _make_engine, _make_ha
from .test_house_engine import _house, _started
from .test_openings_engine import _two_scheduled_rooms

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
    assert (wait["direction"], wait["obeyed"], wait["excess"]) == ("cooling", True, 2.5)
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
    assert engine.building_wait["excess"] == 2.5  # 3 °F over, less the 0.5 °F deadband
    temps = {"r1": None, "r2": None}
    engine._get_avg_temp = lambda room, **_k: temps[room.id]
    from backend.engine.room_manager import get_active_rooms

    active = {ar.room.id: ar for ar in await get_active_rooms(conn, engine.thermostat_entity_id)}
    tc = await engine._load_tc(conn)
    await engine._keep_to_building_side(
        conn, "cooling", "heating", True, active, tc, None, None, None
    )
    assert engine.building_wait["excess"] == 0.0
    await conn.close()


async def _scheduled(temps, side, obey=True, *, ambient=72.0):
    """Two rooms on an all-day schedule to 72 °F (no house band)."""
    conn = await _two_scheduled_rooms()
    engine = _make_engine(_make_ha(ambient=ambient))
    engine._get_avg_temp = lambda room, **_k: temps[room.id]
    engine._reset_setpoint_to_ambient = AsyncMock()
    engine._enforce_safety_setpoint = AsyncMock(return_value=False)
    started = AsyncMock()
    engine._start_or_update_cycle = started
    engine._monitor_rooms = AsyncMock()
    engine._get_building_side = lambda: (side, obey)
    engine._logger = AsyncMock()
    return conn, engine, started


@pytest.mark.parametrize(
    ("temp", "side", "mode"),
    [(40.0, "cooling", "heating"), (95.0, "heating", "cooling"), (95.0, "hold", "cooling")],
)
async def test_a_scheduled_room_past_a_safety_limit_is_never_held(temp, side, mode):
    """Rooms with their own demand are protected by their vote, not by safety rooms."""
    conn, engine, started = await _scheduled({"r1": temp, "r2": 72.0}, side, ambient=temp)
    await engine._do_tick(conn)
    assert _started(started)[1] == mode
    assert engine.building_wait is None
    await conn.close()


async def test_a_fire_warmed_room_over_the_limit_is_not_a_reason_to_cool():
    conn, engine, started = await _scheduled({"r1": 95.0, "r2": 72.0}, "heating", ambient=80.0)
    engine._get_fireplace_rooms = lambda: frozenset({"r1"})
    tc = await engine._load_tc(conn)
    from backend.engine.room_manager import get_active_rooms

    active = {ar.room.id: ar for ar in await get_active_rooms(conn, engine.thermostat_entity_id)}
    assert engine._safety_breaches(active, tc) == set()
    engine._get_fireplace_rooms = None
    assert engine._safety_breaches(active, tc) == {"cooling"}
    await conn.close()


async def test_the_wait_ends_when_the_zone_stops_wanting_the_other_side():
    temps = {"r1": 75.0, "r2": 72.0}
    conn, engine, started = await _scheduled(temps, "heating", ambient=75.0)
    await engine._do_tick(conn)
    first = engine.building_wait
    assert first["direction"] == "cooling"
    await engine._do_tick(conn)
    assert engine.building_wait["since"] == first["since"]  # the same wait, not a new one
    engine._enforce_safety_setpoint.assert_awaited()  # held: the zone's own reading is checked
    # A door opens and the zone is paused: it is no longer waiting for anything.
    engine._get_openings = lambda: (True, frozenset())
    await engine._do_tick(conn)
    assert engine.building_wait is None
    engine._get_openings = None
    # The room comes back to its target.
    temps["r1"] = 72.0
    await engine._do_tick(conn)
    assert engine.building_wait is None and engine._wait_started is None
    # Wanting it again later is a new wait with a new start, logged again.
    temps["r1"] = 75.0
    await engine._do_tick(conn)
    assert engine.building_wait["since"] > first["since"]
    assert len(engine._logger.log.await_args_list) == 2
    started.assert_not_awaited()
    await conn.close()


async def test_a_wait_not_seen_for_a_few_minutes_starts_over():
    from datetime import UTC, datetime, timedelta

    conn, engine, _started_mock = await _scheduled({"r1": 75.0, "r2": 72.0}, "heating")
    long_ago = datetime.now(UTC) - timedelta(hours=2)
    engine._wait_started = ("cooling", True, long_ago, long_ago)
    await engine._do_tick(conn)
    assert engine.building_wait["since"] > long_ago
    await conn.close()


async def test_nothing_starts_while_another_zone_finishes_the_other_way():
    conn, engine, started = await _scheduled({"r1": 68.0, "r2": 72.0}, "hold", ambient=68.0)
    await engine._do_tick(conn)
    started.assert_not_awaited()
    assert engine.building_wait is None
    await conn.close()


async def test_the_first_zone_to_start_sets_the_side_for_a_building_with_none():
    conn, engine, started = await _scheduled({"r1": 75.0, "r2": 72.0}, None, ambient=75.0)
    asked: list[str] = []
    engine._claim_building_side = lambda d: asked.append(d) or "heating"
    await engine._do_tick(conn)  # another zone claimed heating first
    started.assert_not_awaited()
    assert asked == ["cooling"] and engine.building_wait["direction"] == "cooling"
    engine._claim_building_side = lambda d: d
    await engine._do_tick(conn)
    assert _started(started)[1] == "cooling"
    await conn.close()


async def test_a_zone_that_could_not_run_the_other_way_does_not_ask_for_a_switch():
    # The thermostat has no cooling mode.
    conn, engine, started = await _scheduled({"r1": 75.0, "r2": 72.0}, "heating", ambient=75.0)
    engine._ha.get_state.return_value["attributes"]["hvac_modes"] = ["heat", "off"]
    await engine._do_tick(conn)
    started.assert_not_awaited()
    assert engine.building_wait is None
    # Watching only: nothing is held, and nothing is recorded either.
    engine._get_building_side = lambda: ("heating", False)
    await engine._do_tick(conn)
    assert engine.building_wait is None
    await conn.close()
    # Too cold outside to cool.
    conn, engine, started = await _scheduled({"r1": 75.0, "r2": 72.0}, "heating", ambient=75.0)
    engine._cooling_lockout_state = AsyncMock(return_value=("locked_out", 30.0))
    await engine._do_tick(conn)
    started.assert_not_awaited()
    assert engine.building_wait is None
    # With cooling allowed again and a mode that can cool, it waits as usual.
    engine._cooling_lockout_state = AsyncMock(return_value=("ok", 70.0))
    engine._ha.get_state.return_value["attributes"]["hvac_modes"] = ["heat_cool", "off"]
    await engine._do_tick(conn)
    assert engine.building_wait["direction"] == "cooling"
    await conn.close()
