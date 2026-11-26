"""Zone Balance inside the cycle engine: which rooms answer a balancing call."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
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
NOW = datetime(2026, 1, 5, 12, 0, tzinfo=UTC)


async def _setup(temp=64.0, call=HEAT):
    conn = await _conn()
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    engine = _make_engine(_make_ha(ambient=temp, hvac_mode="heat", hvac_action="idle"))
    temps = {"now": temp}
    engine._get_avg_temp = lambda _room, **_k: temps["now"]
    engine._get_balance = lambda: call
    return conn, engine, room, temps


def _run(engine, started, mode="heating") -> None:
    """The cycle started with these rooms and is running."""
    engine._state, engine._cycle_mode = CycleState.RUNNING, mode
    engine._active_rooms = {ar.room.id: ar for ar in started}


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
    _run(engine, await engine._balance(conn, []))
    temps["now"] = 66.8
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance")]
    temps["now"] = None  # nor for a reading that goes missing
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance")]
    await conn.close()


async def test_a_call_that_lapses_mid_run_does_not_cut_the_run_short():
    """The call comes and goes with the other zone's temperature; the run must end by itself."""
    conn, engine, room, temps = await _setup()
    _run(engine, await engine._balance(conn, []))
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
    started = await engine._balance(conn, [])
    other = Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, other)
    _run(engine, started)
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


async def test_a_room_asked_while_the_zone_ran_for_someone_else_is_not_held_to_it():
    """Asked to heat, but the zone cooled for a hold: it never joined, so it is judged afresh."""
    conn, engine, room, temps = await _setup()
    await engine._balance(conn, [])  # asked, at 64 °F
    other = Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, other)
    hold = ActiveRoom(room=other, target_temp=74.0, source="override")
    _run(engine, [hold], mode="cooling")
    # The call lapses and the room is at 71.8 °F: nothing puts it into the cooling run.
    engine._get_balance = lambda: None
    temps["now"] = 71.8
    assert await engine._balance(conn, [hold]) == [hold]
    await conn.close()


async def test_before_a_cycle_is_chosen_balancing_rooms_give_way_to_any_room_that_calls():
    conn, engine, room, _temps = await _setup()
    tc = await db.get_thermostat_config(conn, THERMO_ID)
    other = Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID)
    third = Room.create(name="Loft", thermostat_entity_id=THERMO_ID)
    temps = {room.id: 64.0, other.id: 80.0, third.id: 64.0}
    engine._get_avg_temp = lambda r, **_k: temps[r.id]
    was = ActiveRoom(room=room, target_temp=62.0, source="house", heat_to=62.0, cool_to=78.0)

    def asked(*others):
        engine._optional_replaced = {room.id: was, third.id: None}
        found = {
            room.id: ActiveRoom(room=room, target_temp=67.0, source="balance"),
            third.id: ActiveRoom(room=third, target_temp=67.0, source="balance"),
        }
        found.update({ar.room.id: ar for ar in others})
        return found

    # A hold that wants cooling: the balancing rooms go back to what they were.
    hold = ActiveRoom(room=other, target_temp=74.0, source="override")
    active = asked(hold)
    engine._optional_rooms_yield(active, tc)
    assert active == {room.id: was, other.id: hold}
    # So does a room outside its band, and one with no reading to judge by.
    banded = ActiveRoom(room=other, target_temp=62.0, source="house", heat_to=62.0, cool_to=78.0)
    active = asked(banded)
    engine._optional_rooms_yield(active, tc)
    assert set(active) == {room.id, other.id} and active[room.id] is was
    temps[other.id] = None
    active = asked(hold)
    engine._optional_rooms_yield(active, tc)
    assert active[room.id] is was
    # A room resting at its target, or inside its band, asks for nothing: they stay.
    temps[other.id] = 74.2
    for resting in (hold, banded):
        active = asked(resting)
        engine._optional_rooms_yield(active, tc)
        assert active[room.id].source == "balance" and third.id in active
    # A cycle running for nothing but balancing rooms ends for a room that
    # calls the other way, once it has had its minimum runtime.
    temps[other.id] = 80.0
    running = asked(hold)
    engine._state, engine._cycle_mode = CycleState.RUNNING, "heating"
    engine._active_rooms = {room.id: running[room.id], third.id: running[third.id]}
    engine._cycle_runtime_satisfied = lambda _tc, now=None: False
    engine._optional_rooms_yield(running, tc)
    assert running[room.id].source == "balance"
    engine._cycle_runtime_satisfied = lambda _tc, now=None: True
    engine._optional_rooms_yield(running, tc)
    assert running == {room.id: was, other.id: hold}
    # Not for a call the building's side rules out, which no cycle could
    # answer: ending the run would only start it again a minute later.
    # That is only so where the side is the building's own setting. Where the
    # building chooses, the run ends, so the zone can wait for it to switch.
    running = asked(hold)
    engine._optional_rooms_yield(running, tc, "heating")
    assert running[room.id] is was
    engine._get_side_fixed = lambda: True
    running = asked(hold)
    engine._optional_rooms_yield(running, tc, "heating")
    assert running[room.id].source == "balance" and engine.optional_only
    # A room past a safety limit is answered whatever the side, and so is a
    # call for the side itself.
    temps[other.id] = tc.max_setpoint + 1
    running = asked(hold)
    engine._optional_rooms_yield(running, tc, "heating")
    assert running[room.id] is was
    temps[other.id] = 80.0
    running = asked(hold)
    engine._optional_rooms_yield(running, tc, "cooling")
    assert running[room.id] is was
    # A run for nothing but balancing rooms that finds itself against the
    # building's side ends too, with nobody calling, so no zone waits on it.
    temps[other.id] = 74.2
    for side, stays in (("heating", True), (None, True), ("hold", True), ("cooling", False)):
        running = asked(hold)
        engine._optional_rooms_yield(running, tc, side)
        assert (running[room.id].source == "balance") is stays
    temps[other.id] = 80.0
    engine._get_side_fixed = None
    # A room that wants the same direction simply joins the run.
    temps[other.id] = 70.0
    running = asked(hold)
    engine._optional_rooms_yield(running, tc)
    assert running[room.id].source == "balance"
    # And a run still working for a room with a say of its own is left alone...
    temps[other.id] = 80.0
    running = asked(hold)
    # (`other` is in the heating run with a target of 70 °F, and now reads 80:
    # it wants cooling as a hold, and is long done as far as this run goes.)
    served = ActiveRoom(room=other, target_temp=70.0, source="schedule")
    engine._active_rooms[other.id] = served
    engine._run_called = {other.id}  # it called earlier in the run

    def state(closed, target=70.0):
        return {other.id: SimpleNamespace(vent_closed_at=closed, target_temp=target)}

    # Not yet started for that room, or still short of its target: left alone.
    engine._room_cycle_states = {}
    engine._optional_rooms_yield(running, tc)
    assert running[room.id].source == "balance"
    engine._room_cycle_states = state(None, target=85.0)
    engine._optional_rooms_yield(running, tc)
    assert running[room.id].source == "balance"
    # ...but not once that room is done and only the balancing rooms keep the
    # run going: at its target with its vent held open by the airflow floor,
    running = asked(hold)
    engine._room_cycle_states = state(None)
    engine._optional_rooms_yield(running, tc)
    assert running[room.id] is was
    # with its vent closed,
    running = asked(hold)
    engine._room_cycle_states = state(NOW)
    engine._optional_rooms_yield(running, tc)
    assert running[room.id] is was
    # or with no reading to hold the run open at all.
    temps[other.id] = None
    engine._thermo_ambient_f = lambda: 80.0
    running = asked(hold)
    engine._optional_rooms_yield(running, tc)
    assert running[room.id] is was
    del engine._thermo_ambient_f
    # A served room that has drifted back past its deadband still needs the run.
    temps[other.id] = 80.0
    third_hold = ActiveRoom(room=third, target_temp=60.0, source="override")
    engine._active_rooms = {room.id: asked()[room.id], other.id: served}
    engine._room_cycle_states = state(NOW, target=85.0)
    running = asked(third_hold)
    del running[third.id]
    running[third.id] = third_hold
    engine._optional_rooms_yield(running, tc)
    assert running[room.id].source == "balance"
    engine._state, engine._active_rooms, engine._room_cycle_states = CycleState.IDLE, {}, {}
    # With no reading: a house band room asks for nothing; another goes by the
    # thermostat's reading (64 °F here, so a hold at 74 calls and one at 64 does
    # not); and with no thermostat reading either, it counts as calling.
    temps[other.id] = None
    active = asked(banded)
    engine._optional_rooms_yield(active, tc)
    assert active[room.id].source == "balance"
    cool_hold = ActiveRoom(room=other, target_temp=64.0, source="override")
    active = asked(cool_hold)
    engine._optional_rooms_yield(active, tc)
    assert active[room.id].source == "balance"
    engine._thermo_ambient_f = lambda: None
    active = asked(cool_hold)
    engine._optional_rooms_yield(active, tc)
    assert active[room.id] is was
    # And with no balancing rooms there is nothing to do.
    active = {other.id: hold}
    engine._optional_rooms_yield(active, tc)
    assert active == {other.id: hold}
    await conn.close()


async def test_a_run_kept_going_only_by_conveniences_says_nothing_of_the_buildings_side():
    conn, engine, room, _temps = await _setup()
    tc = await db.get_thermostat_config(conn, THERMO_ID)
    other = Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID)
    late = Room.create(name="Office", thermostat_entity_id=THERMO_ID)
    temps = {room.id: 64.0, other.id: 68.0, late.id: 76.0}
    engine._get_avg_temp = lambda r, **_k: temps[r.id]
    balancing = ActiveRoom(room=room, target_temp=67.0, source="balance")
    hold = ActiveRoom(room=other, target_temp=70.0, source="override")
    _run(engine, [balancing, hold])
    engine._room_cycle_states = {
        other.id: SimpleNamespace(vent_closed_at=None, target_temp=70.0),
        room.id: SimpleNamespace(vent_closed_at=None, target_temp=67.0),
    }
    engine._cycle_runtime_satisfied = lambda _tc, now=None: False
    # Before the first tick there is nothing to judge a room "done" by.
    assert not engine.optional_only
    running = {room.id: balancing, other.id: hold}
    engine._optional_rooms_yield(running, tc)
    # The hold is still being heated: this is its run, and it holds the side.
    assert not engine.optional_only
    # Once it has arrived, only the balancing room keeps the run going.
    temps[other.id] = 70.4
    assert engine.optional_only
    # A run with no convenience room in it is never one.
    engine._active_rooms = {other.id: hold}
    assert not engine.optional_only
    engine._active_rooms = {room.id: balancing, other.id: hold}

    # While such a run serves out its minimum runtime against the building's
    # side, a room that asks now does not join it (and so keep it going).
    newcomer = ActiveRoom(room=late, target_temp=70.0, source="override")
    running = {room.id: balancing, other.id: hold, late.id: newcomer}
    engine._optional_rooms_yield(running, tc, "cooling")
    assert set(running) == {room.id, other.id}
    # A room past a safety limit is never held back, nor is anyone when the
    # run is with the side, or still working for a room of its own.
    safety = ActiveRoom(room=late, target_temp=70.0, source="safety")
    running = {room.id: balancing, other.id: hold, late.id: safety}
    engine._optional_rooms_yield(running, tc, "cooling")
    assert late.id in running
    running = {room.id: balancing, other.id: hold, late.id: newcomer}
    engine._optional_rooms_yield(running, tc, "heating")
    assert late.id in running
    temps[other.id] = 68.0
    engine._optional_rooms_yield(running, tc, "cooling")
    assert late.id in running
    await conn.close()


async def test_which_rooms_are_counted_as_having_called():
    conn, engine, room, _temps = await _setup()
    tc = await db.get_thermostat_config(conn, THERMO_ID)
    cold = Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID)
    resting = Room.create(name="Loft", thermostat_entity_id=THERMO_ID)
    joiner = Room.create(name="Office", thermostat_entity_id=THERMO_ID)
    temps = {room.id: 64.0, cold.id: 66.0, resting.id: 69.8, joiner.id: 80.0}
    engine._get_avg_temp = lambda r, **_k: temps[r.id]

    def hold(r, target=70.0):
        return ActiveRoom(room=r, target_temp=target, source="override")

    balancing = ActiveRoom(room=room, target_temp=67.0, source="balance")
    # With the zone idle: a room that is calling, not one resting in its deadband,
    # and never a convenience room. It is worked out with no convenience about, too.
    active = {room.id: balancing, cold.id: hold(cold), resting.id: hold(resting)}
    engine._optional_rooms_yield(dict(active), tc)
    assert engine._run_called == {cold.id}
    engine._run_called = set()
    engine._optional_rooms_yield({cold.id: hold(cold), resting.id: hold(resting)}, tc)
    assert engine._run_called == {cold.id}
    # During a run: a room seen past its deadband, and a room asking for the
    # run's own direction (it is joining). Not one asking for the other.
    _run(engine, list(active.values()))
    engine._run_called = set()
    engine._room_cycle_states = {
        rid: SimpleNamespace(vent_closed_at=None, target_temp=70.0) for rid in active
    }
    temps[cold.id] = 69.8
    engine._optional_rooms_yield(dict(active), tc)
    assert engine._run_called == set()
    temps[resting.id] = 69.2
    engine._optional_rooms_yield(dict(active), tc)
    assert engine._run_called == {resting.id}
    engine._run_called = set()
    temps[resting.id] = 69.8
    engine._optional_rooms_yield(active | {joiner.id: hold(joiner)}, tc)
    assert engine._run_called == set()  # it wants cooling
    temps[joiner.id] = 66.0
    engine._optional_rooms_yield(active | {joiner.id: hold(joiner)}, tc)
    assert engine._run_called == {joiner.id}
    # A room not yet set up in the run is judged only by what it asks for; one
    # with no reading by the thermostat's own, as the vote judges it.
    engine._run_called = set()
    temps[resting.id] = None
    del engine._room_cycle_states[cold.id]
    temps[cold.id] = 60.0
    temps[joiner.id] = 80.0
    engine._optional_rooms_yield(active | {joiner.id: hold(joiner)}, tc)
    assert engine._run_called == {cold.id, resting.id}
    engine._thermo_ambient_f = lambda: 70.0
    engine._run_called = set()
    engine._optional_rooms_yield(active | {joiner.id: hold(joiner)}, tc)
    assert engine._run_called == {cold.id}
    # While the run is on its way out against the building's side, nobody new
    # is counted: a room that starts to ask then does not make the run its own.
    engine._run_called = set()
    engine._room_cycle_states[cold.id] = SimpleNamespace(vent_closed_at=None, target_temp=70.0)
    temps[resting.id] = 69.0
    engine._cycle_runtime_satisfied = lambda _tc, now=None: False
    engine._optional_rooms_yield(dict(active), tc, "cooling")
    assert engine._run_called == set() and engine.optional_only
    engine._optional_rooms_yield(dict(active), tc, "heating")
    assert engine._run_called == {cold.id, resting.id} and not engine.optional_only
    await conn.close()


async def test_what_another_zone_is_waiting_for_counts_as_the_side_where_the_building_chooses():
    conn, engine, _room, _temps = await _setup()
    engine._get_building_waiting = lambda: "cooling"
    # No building, or one only watched: nothing changes.
    assert engine._side_for_optional() == (None, False)
    engine._get_building_side = lambda: ("heating", False)
    assert engine._side_for_optional() == ("heating", False)
    # On no side yet, and on a side another zone is waiting to leave.
    engine._get_building_side = lambda: (None, True)
    assert engine._side_for_optional() == ("cooling", True)
    engine._get_building_side = lambda: ("heating", True)
    assert engine._side_for_optional() == ("cooling", True)
    # So a balancing call for heating is not answered there...
    assert await engine._balance(conn, []) == []
    # ...but it is where the side is the building's own setting, which no
    # waiting changes, and where nobody is waiting, or waiting for the same.
    engine._get_side_fixed = lambda: True
    assert engine._side_for_optional() == ("heating", True)
    assert await engine._balance(conn, []) != []
    engine._get_side_fixed = lambda: False
    for waiting in (None, "heating"):
        engine._get_building_waiting = lambda waiting=waiting: waiting
        assert engine._side_for_optional() == ("heating", True)
    engine._get_building_waiting = None
    assert engine._side_for_optional() == ("heating", True)
    await conn.close()


async def test_nothing_new_is_asked_while_a_call_in_the_zone_waits_to_coast():
    conn, engine, room, _temps = await _setup()
    other = Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, other)
    assert not engine.optional_only
    engine._coast_wait = {"another-room": (NOW, "cooling", 74.0)}
    assert await engine._balance(conn, []) == []
    # A run already going is not a wait any more, and its rooms are kept.
    asked = [ActiveRoom(room=room, target_temp=67.0, source="balance")]
    _run(engine, asked)
    assert _targets(await engine._balance(conn, [])) == [(67.0, "balance"), (67.0, "balance")]
    await conn.close()


async def test_a_balancing_room_past_a_safety_limit_is_still_protected():
    """Its balancing target is not a protection: a breach takes the room over."""
    conn, engine, room, temps = await _setup(temp=86.0)  # the zone's maximum is 80 °F
    active = {room.id: ActiveRoom(room=room, target_temp=67.0, source="balance")}
    await engine._add_safety_rooms(conn, active)
    assert active[room.id].source == "safety" and active[room.id].target_temp < 80.0
    # A hold, a schedule or occupancy is already looking after its room, as before.
    active = {room.id: ActiveRoom(room=room, target_temp=67.0, source="override")}
    await engine._add_safety_rooms(conn, active)
    assert active[room.id].source == "override"
    await conn.close()


async def test_while_the_zone_runs_the_other_way_for_someone_else_nothing_is_asked():
    conn, engine, room, _temps = await _setup()
    other = Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, other)
    hold = ActiveRoom(room=other, target_temp=60.0, source="override")
    _run(engine, [hold], mode="cooling")
    assert await engine._balance(conn, [hold]) == [hold]
    # The same way, it may join.
    _run(engine, [hold], mode="heating")
    assert len(await engine._balance(conn, [hold])) == 2
    await conn.close()
