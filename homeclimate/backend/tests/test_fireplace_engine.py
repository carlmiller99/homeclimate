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


async def test_vacation_mode_never_cools_a_zone_a_fire_is_warming():
    """Range and single-setpoint holds alike: hot from a fire means off, not cooling."""
    from backend import db
    from backend.models import ThermostatConfig

    from .test_cycle_engine import THERMO_ID
    from .test_cycle_engine_gaps_c import _make_engine as _engine_with_logger
    from .test_cycle_engine_gaps_c import _make_ha as _ha_with_awaits

    for vacation_mode in ("range", "single"):
        conn = await _two_scheduled_rooms()
        tc = ThermostatConfig(thermostat_entity_id=THERMO_ID, name="Zone")
        tc.min_setpoint, tc.max_setpoint, tc.vacation_hvac_mode = 62.0, 80.0, vacation_mode
        await db.upsert_thermostat_config(conn, tc)
        ha = _ha_with_awaits(ambient=88.0)
        logger = AsyncMock()
        engine = _engine_with_logger(ha, logger)
        engine._get_fireplace_rooms = lambda: frozenset({"r1"})
        hot = {"state": "cool", "attributes": {"current_temperature": 88.0}}
        for _ in range(3):
            await engine._apply_vacation_hold(conn, hot)
        ha.set_thermostat_temperature_range.assert_not_awaited()
        ha.set_thermostat_temperature.assert_not_awaited()
        ha.set_thermostat_hvac_mode.assert_awaited_with(THERMO_ID, "off")
        messages = [c.args[2] for c in logger.log.await_args_list]
        assert len(messages) == 1 and "cooling is not commanded" in messages[0], vacation_mode

        # Inside the band it parks in heat, never cool: the fire's own heat on
        # the thermostat must not be able to start the compressor. (A fresh
        # engine, so nothing from the ticks above is cached.)
        park_ha = _ha_with_awaits(ambient=72.0)
        parked = _engine_with_logger(park_ha, AsyncMock())
        parked._get_fireplace_rooms = lambda: frozenset({"r1"})
        inside = {"state": "heat_cool", "attributes": {"current_temperature": 72.0}}
        await parked._apply_vacation_hold(conn, inside)
        park_ha.set_thermostat_temperature_range.assert_not_awaited()
        assert park_ha.set_thermostat_temperature.await_args.kwargs.get("hvac_mode") == "heat"

        # A failed "off" says so and is retried next tick, not raised.
        ha.set_thermostat_hvac_mode.side_effect = RuntimeError("rejected")
        engine._ambient_eval_at = None
        await engine._apply_vacation_hold(conn, hot)
        assert "could not turn the equipment off" in logger.log.await_args_list[-1].args[2]
        await conn.close()

    # No fire: the range hold is used as before.
    conn = await _two_scheduled_rooms()
    tc = ThermostatConfig(thermostat_entity_id=THERMO_ID, name="Zone")
    tc.vacation_hvac_mode = "range"
    await db.upsert_thermostat_config(conn, tc)
    ha = _ha_with_awaits(ambient=88.0)
    engine = _engine_with_logger(ha, AsyncMock())
    engine._get_fireplace_rooms = lambda: frozenset({"elsewhere"})
    await engine._apply_vacation_hold(
        conn, {"state": "cool", "attributes": {"current_temperature": 88.0}}
    )
    ha.set_thermostat_temperature_range.assert_awaited()
    await conn.close()
