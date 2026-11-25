"""Zone Balance inside the cycle engine: which rooms answer a balancing call."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from backend import db, house
from backend.engine.cycle_engine import CycleState
from backend.engine.room_manager import ActiveRoom
from backend.models import Room
from backend.zone_balance import Call

from .test_cycle_engine import _make_engine, _make_ha
from .test_heat_pump import THERMO_ID, _conn

pytestmark = pytest.mark.asyncio

HEAT = Call("heating", 67.0, "climate.other", 6.0)


async def _setup(temp=64.0, call=HEAT):
    conn = await _conn()
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    engine = _make_engine(_make_ha(ambient=temp, hvac_mode="heat", hvac_action="idle"))
    temps = {"now": temp}
    engine._get_avg_temp = lambda _room, **_k: temps["now"]
    engine._get_balance = lambda: call
    return conn, engine, room, temps


def _targets(active) -> list[tuple[float, str]]:
    return [(ar.target_temp, ar.source) for ar in active]


async def test_a_room_short_of_the_call_answers_it_and_is_kept_to_the_end_of_the_run():
    conn, engine, room, temps = await _setup()
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance")]
    # Asked, but nothing is running for it yet: it is not shown as being balanced.
    assert engine._balance_latch == {room.id: 67.0} and engine.balance_rooms == []
    # Close enough: with nothing running it asks for nothing.
    temps["now"] = 66.8
    assert await engine._balance(conn, []) == []
    # But a room that started the run is kept until the run ends, so the
    # equipment is not stopped the moment it is inside its deadband.
    temps["now"] = 64.0
    await engine._balance(conn, [])
    engine._state, engine._cycle_mode = CycleState.RUNNING, "heating"
    temps["now"] = 66.8
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance")]
    temps["now"] = None  # nor for a reading that goes missing
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance")]
    await conn.close()


async def test_a_call_that_lapses_mid_run_does_not_cut_the_run_short():
    """The call comes and goes with the other zone's temperature; the run must end by itself."""
    conn, engine, room, temps = await _setup()
    await engine._balance(conn, [])
    engine._state, engine._cycle_mode = CycleState.RUNNING, "heating"
    # The zones are back within the limit, or the other zone's hold has ended.
    engine._get_balance = lambda: None
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance")]
    # The call comes back with another target: the run keeps the one it started with.
    engine._get_balance = lambda: Call("heating", 68.5, "climate.other", 7.0)
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance")]
    # A call the other way changes nothing for the run either.
    engine._get_balance = lambda: Call("cooling", 60.0, "climate.other", 7.0)
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance")]
    # A room that gains a target of its own, or goes out of use, leaves it.
    own = [ActiveRoom(room=room, target_temp=70.0, source="override")]
    assert await engine._balance(conn, own) == own
    assert engine._balance_latch == {}
    # Once the run is over, a lapsed call asks for nothing.
    engine._get_balance = lambda: None
    engine._state = CycleState.IDLE
    assert await engine._balance(conn, []) == [] and engine._balance_latch == {}
    engine._get_balance = None
    assert await engine._balance(conn, []) == []
    await conn.close()


async def test_a_lapsed_call_keeps_the_rooms_in_the_run_and_adds_no_others():
    conn, engine, room, temps = await _setup()
    await engine._balance(conn, [])
    other = Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, other)
    engine._state, engine._cycle_mode = CycleState.RUNNING, "heating"
    engine._get_balance = lambda: None
    assert [ar.room.id for ar in await engine._balance(conn, [])] == [room.id]
    # With a call, a room with no reading cannot be judged and is left out.
    engine._state = CycleState.IDLE
    engine._get_balance = lambda: HEAT
    temps["now"] = None
    assert await engine._balance(conn, []) == []
    await conn.close()


async def test_after_a_restart_a_balancing_run_is_carried_on():
    conn, engine, room, temps = await _setup()
    engine._state, engine._cycle_mode = CycleState.RUNNING, "heating"
    engine._active_rooms = {room.id: ActiveRoom(room=room, target_temp=67.0, source="balance")}
    assert engine.balance_rooms == [room.id]
    assert engine.get_zone_status().balance_rooms == [room.id]
    temps["now"] = 66.8  # inside the deadband: a fresh look would drop it
    engine._get_balance = lambda: None
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance")]
    # Eco had relaxed it to 66 °F: it is carried on at what was asked for.
    engine._balance_latch = {}
    engine._active_rooms[room.id].target_temp = 66.0
    engine._active_rooms[room.id].requested_target = 67.0
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance")]
    await conn.close()


async def test_never_a_reason_to_ask_the_building_for_its_other_side():
    conn, engine, _room, _temps = await _setup()
    engine._get_building_side = lambda: ("cooling", True)
    assert await engine._balance(conn, []) == []
    engine._get_building_side = lambda: ("cooling", False)  # only watched
    assert await engine._balance(conn, []) != []
    engine._balance_latch = {}
    engine._get_building_side = lambda: ("heating", True)
    assert await engine._balance(conn, []) != []
    await conn.close()


async def test_a_schedule_room_waiting_to_coast_is_not_taken_over():
    conn, engine, room, _temps = await _setup()
    # Coasting took it out of this tick's rooms; it still has its schedule.
    engine._coast_wait = {room.id: (None, "heating", 66.0)}
    assert await engine._balance(conn, []) == []
    await conn.close()


async def test_cooling_and_the_zones_own_limits():
    conn, engine, _room, _temps = await _setup(temp=80.0, call=Call("cooling", 75.0, "x", 6.0))
    assert _targets(await engine._balance(conn, [])) == [(75.0, "balance")]
    # A call past the zone's setpoint limits is held to them (max 80 °F here).
    engine._get_balance = lambda: Call("heating", 90.0, "x", 12.0)
    engine._get_avg_temp = lambda _room, **_k: 70.0
    assert _targets(await engine._balance(conn, [])) == [(80.0, "balance")]
    await conn.close()


async def test_rooms_with_something_of_their_own_and_rooms_not_in_use_are_left_alone():
    conn, engine, room, _temps = await _setup()
    for source in ("override", "schedule", "presence"):
        own = [ActiveRoom(room=room, target_temp=62.0, source=source)]
        assert await engine._balance(conn, own) == own
    await house.set_switches(conn, room.id, {"in_use": False})
    assert await engine._balance(conn, []) == []
    await conn.close()


async def test_a_room_following_the_house_band_is_balanced_only_inside_it():
    conn, engine, room, _temps = await _setup()

    def band(heat_to, cool_to):
        return [
            ActiveRoom(
                room=room, target_temp=heat_to, source="house", heat_to=heat_to, cool_to=cool_to
            )
        ]

    # 62 to 78 °F: 67 °F is inside, and more than the band asks for.
    assert _targets(await engine._balance(conn, band(62.0, 78.0))) == [(67.0, "balance")]
    # The band already asks for 68 °F: it is left to the band.
    assert await engine._balance(conn, band(68.0, 78.0)) == band(68.0, 78.0)
    # The target would be past the band's other edge.
    assert await engine._balance(conn, band(60.0, 66.0)) == band(60.0, 66.0)
    # Cooling: 75 °F inside 62 to 78, but not when the band cools to 75 anyway.
    engine._get_balance = lambda: Call("cooling", 75.0, "x", 6.0)
    engine._get_avg_temp = lambda _room, **_k: 77.0
    assert _targets(await engine._balance(conn, band(62.0, 78.0))) == [(75.0, "balance")]
    assert await engine._balance(conn, band(62.0, 75.0)) == band(62.0, 75.0)
    await conn.close()


async def test_through_the_engine_a_balancing_room_starts_a_cycle_and_a_pause_still_stops_it(
    monkeypatch,
):
    from backend.engine import cycle_engine

    conn, engine, room, _temps = await _setup()
    monkeypatch.setattr(cycle_engine, "get_active_rooms", AsyncMock(return_value=[]))
    engine._reset_setpoint_to_ambient = AsyncMock()
    engine._monitor_rooms = AsyncMock()
    started = AsyncMock()
    engine._start_or_update_cycle = started
    await engine._do_tick(conn)
    active, mode = started.await_args.args[1], started.await_args.args[2]
    assert mode == "heating" and _targets(active.values()) == [(67.0, "balance")]
    # Never into a paused zone.
    started.reset_mock()
    engine._get_openings = lambda: (True, frozenset())
    await engine._do_tick(conn)
    started.assert_not_awaited()
    engine._get_openings = lambda: (False, frozenset({room.id}))
    await engine._do_tick(conn)
    started.assert_not_awaited()
    await conn.close()


async def test_balancing_rooms_never_outvote_a_room_with_a_say_of_its_own():
    """Two rooms asked to heat for balance must not stop a third being cooled."""
    conn, engine, room, _temps = await _setup()
    rooms = [room]
    for name in ("Craft Room", "Loft"):
        extra = Room.create(name=name, thermostat_entity_id=THERMO_ID)
        await db.upsert_room(conn, extra)
        rooms.append(extra)
    temps = {rooms[0].id: 64.0, rooms[1].id: 64.0, rooms[2].id: 80.0}
    engine._get_avg_temp = lambda r, **_k: temps[r.id]
    active = {
        rooms[0].id: ActiveRoom(room=rooms[0], target_temp=67.0, source="balance"),
        rooms[1].id: ActiveRoom(room=rooms[1], target_temp=67.0, source="balance"),
        rooms[2].id: ActiveRoom(room=rooms[2], target_temp=76.0, source="safety"),
    }
    assert await engine._infer_mode_from_room_temps(active, 0.5) == "cooling"
    # A hold, a schedule or occupancy has the same standing.
    active[rooms[2].id].source = "override"
    assert await engine._infer_mode_from_room_temps(active, 0.5) == "cooling"
    # With nobody else asking, they decide for themselves.
    del active[rooms[2].id]
    assert await engine._infer_mode_from_room_temps(active, 0.5) == "heating"
    assert await engine._infer_mode_from_room_temps(active, 0.5, only="heating") == "heating"
    await conn.close()
