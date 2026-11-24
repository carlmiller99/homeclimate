"""Rooms a lit fireplace sets aside, inside the cycle engine (Smart Control)."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from .test_cycle_engine import _make_engine, _make_ha
from .test_openings_engine import _two_scheduled_rooms

pytestmark = pytest.mark.asyncio


async def _active_after_tick(temps: dict[str, float], *, paused: set[str], fire: set[str] | None):
    conn = await _two_scheduled_rooms()
    engine = _make_engine(_make_ha(ambient=72.0))
    engine._get_openings = lambda: (False, frozenset(paused))
    engine._get_fireplace_rooms = None if fire is None else (lambda: frozenset(fire))
    engine._get_avg_temp = lambda room, **_k: temps[room.id]  # type: ignore[method-assign]
    infer = AsyncMock(return_value="off")
    engine._infer_mode_from_room_temps = infer  # type: ignore[method-assign]
    engine._reset_setpoint_to_ambient = AsyncMock()  # type: ignore[method-assign]
    await engine._do_tick(conn)
    assert infer.await_args is not None
    active = infer.await_args.args[0]
    await conn.close()
    return {rid: ar.source for rid, ar in active.items()}


async def test_a_fire_warmed_room_is_out_of_demand_and_is_never_cooled_against_the_fire():
    # 90 °F is past the 85 °F safety ceiling, and it is the fire doing it.
    active = await _active_after_tick({"r1": 90.0, "r2": 70.0}, paused={"r1"}, fire={"r1"})
    assert set(active) == {"r2"}


async def test_the_same_room_paused_by_a_door_is_still_cooled_past_the_ceiling():
    for fire in (None, set()):
        active = await _active_after_tick({"r1": 90.0, "r2": 70.0}, paused={"r1"}, fire=fire)
        assert active["r1"] == "safety"


async def test_a_fire_warmed_room_that_gets_too_cold_is_still_heated():
    active = await _active_after_tick({"r1": 50.0, "r2": 70.0}, paused={"r1"}, fire={"r1"})
    assert active["r1"] == "safety"


async def test_the_zone_backstop_does_not_cool_a_thermostat_that_is_reading_the_fire():
    """With no demand at all, a thermostat past the ceiling normally starts cooling."""
    from unittest.mock import AsyncMock as _Mock

    for fire, cools in (({"r1"}, False), ({"elsewhere"}, True), (set(), True), (None, True)):
        conn = await _two_scheduled_rooms()
        engine = _make_engine(_make_ha(ambient=90.0))
        engine._get_fireplace_rooms = None if fire is None else (lambda f=fire: frozenset(f))
        engine._command_safety_bound = _Mock()
        engine._validated_ambient_for_tick = lambda *_a, **_k: 90.0
        fired = await engine._enforce_safety_setpoint(conn, {"state": "heat", "attributes": {}})
        assert fired is cools, fire
        assert engine._command_safety_bound.await_count == int(cools)
        await conn.close()


async def test_the_zone_backstop_still_heats_a_fire_zone_that_is_too_cold():
    from unittest.mock import AsyncMock as _Mock

    conn = await _two_scheduled_rooms()
    engine = _make_engine(_make_ha(ambient=50.0))
    engine._get_fireplace_rooms = lambda: frozenset({"r1"})
    engine._command_safety_bound = _Mock()
    engine._validated_ambient_for_tick = lambda *_a, **_k: 50.0
    assert await engine._enforce_safety_setpoint(conn, {"state": "heat", "attributes": {}}) is True
    assert engine._command_safety_bound.await_args.args[1] == "heat"
    await conn.close()
