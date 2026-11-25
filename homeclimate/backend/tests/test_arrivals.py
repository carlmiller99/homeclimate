"""Get Rooms Ready for Usual Arrivals: when an arrival is coming, and which rooms are asked."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend import arrivals, db, house, learning, room_model, suggestions, tz
from backend.engine.cycle_engine import OPTIONAL_SOURCES, CycleState
from backend.engine.room_manager import ActiveRoom
from backend.models import Room, Schedule

from .test_cycle_engine import _make_engine, _make_ha
from .test_heat_pump import THERMO_ID, _conn

MON = datetime(2026, 1, 5, 13, 40, tzinfo=UTC)  # a Monday, 20 minutes before 14:00
USUAL = frozenset({(0, 14), (0, 15)})  # Mondays, 14:00 to 16:00


def test_the_next_arrival_is_the_first_of_a_run_of_usual_hours():
    at = datetime(2026, 1, 5, 13, 40)
    assert arrivals.next_arrival(USUAL, at) == (datetime(2026, 1, 5, 14, 0), 1200.0)
    # Within the longest lead, and no further.
    assert arrivals.next_arrival(USUAL, datetime(2026, 1, 5, 12, 30))[1] == 5400.0
    assert arrivals.next_arrival(USUAL, datetime(2026, 1, 5, 12, 29)) is None
    # Into the hour it still counts until the grace has passed.
    assert arrivals.next_arrival(USUAL, datetime(2026, 1, 5, 14, 29))[1] == -1740.0
    assert arrivals.next_arrival(USUAL, datetime(2026, 1, 5, 14, 30)) is None
    # The second hour of a run is not an arrival, and neither is another day.
    assert arrivals.next_arrival(USUAL, datetime(2026, 1, 5, 14, 50)) is None
    assert arrivals.next_arrival(USUAL, datetime(2026, 1, 6, 13, 40)) is None
    # Across midnight: Monday 23:00 is usual, so Tuesday 00:00 only continues it.
    late = frozenset({(0, 23), (1, 0), (2, 0)})
    assert arrivals.next_arrival(late, datetime(2026, 1, 5, 23, 40)) is None
    assert arrivals.next_arrival(late, datetime(2026, 1, 6, 23, 40)) == (
        datetime(2026, 1, 7, 0, 0),
        1200.0,
    )
    assert arrivals.next_arrival(frozenset(), at) is None


def test_the_lead_is_the_rooms_own_time_within_bounds():
    assert arrivals.lead_minutes(None) == 30
    assert [arrivals.lead_minutes(m) for m in (0, 15, 40, 90, 200)] == [15, 15, 40, 90, 90]


async def _setup(monkeypatch, *, temp=64.0, outside=40.0, level="on", mode="heat"):
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)
    conn = await _conn()
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    room.system_wide_temp = 70.0
    await db.upsert_room(conn, room)
    await learning.update_settings(conn, {"arrival_level": arrivals.LEVELS.index(level)})
    engine = _make_engine(_make_ha(ambient=temp, hvac_mode=mode, hvac_action="idle"))
    temps = {"now": temp}
    engine._get_avg_temp = lambda _room, **_k: temps["now"]
    engine._read_outside_temp = AsyncMock(return_value=outside)
    engine._logger = AsyncMock()
    engine._usual_hours = (MON - timedelta(hours=3), {room.id: USUAL})
    return conn, engine, room, temps


def _targets(active) -> list[tuple[float, str]]:
    return [(ar.target_temp, ar.source) for ar in active]


def _said(engine) -> list[str]:
    return [c.args[2] for c in engine._logger.log.await_args_list]


@pytest.mark.asyncio
async def test_a_room_is_asked_to_its_occupied_temperature_shortly_before_a_usual_hour(
    monkeypatch,
):
    conn, engine, room, temps = await _setup(monkeypatch)
    assert "arrival" in OPTIONAL_SOURCES
    # Forty minutes ahead is too early without a learned time; twenty is not.
    assert await engine._arrive(conn, [], now=MON - timedelta(minutes=20)) == []
    assert _targets(await engine._arrive(conn, [], now=MON)) == [(70.0, "arrival")]
    assert engine._optional_replaced == {room.id: None} and engine.arrival_rooms == []
    assert _said(engine) == [
        "Getting Bunk Room ready for 14:00, when it is usually in use: heating to 70°F"
    ]
    # Said once for an arrival, however many minutes it is asked for.
    await engine._arrive(conn, [], now=MON + timedelta(minutes=1))
    assert len(_said(engine)) == 1
    # A room following the house band is taken over, and what it was is kept
    # so it can be given back.
    band = ActiveRoom(room=room, target_temp=62.0, source="house", heat_to=62.0, cool_to=78.0)
    assert _targets(await engine._arrive(conn, [band], now=MON)) == [(70.0, "arrival")]
    assert engine._optional_replaced[room.id] is band
    # Nobody there half an hour into the hour: it is let go.
    assert _targets(await engine._arrive(conn, [], now=MON + timedelta(minutes=45))) == [
        (70.0, "arrival")
    ]
    assert await engine._arrive(conn, [], now=MON + timedelta(minutes=50)) == []
    # Warm enough already.
    temps["now"] = 69.6
    assert await engine._arrive(conn, [], now=MON) == []
    await conn.close()


@pytest.mark.asyncio
async def test_too_warm_a_room_is_cooled_to_the_top_of_what_occupancy_would_allow(monkeypatch):
    conn, engine, room, _temps = await _setup(monkeypatch, temp=80.0, outside=95.0, mode="cool")
    assert _targets(await engine._arrive(conn, [], now=MON)) == [(70.0, "arrival")]
    # With a band for occupancy, to its cool-to.
    await house.set_target_band(conn, "presence", room.id, 70.0, 75.0)
    assert _targets(await engine._arrive(conn, [], now=MON)) == [(75.0, "arrival")]
    engine._thermo_ambient_f = lambda: 74.4  # the thermostat reads cooler than that already
    assert await engine._arrive(conn, [], now=MON) == []
    engine._thermo_ambient_f = lambda: 80.0
    # Never past the zone's own limits.
    tc = await db.get_thermostat_config(conn, THERMO_ID)
    tc.min_setpoint = 76.0
    await db.upsert_thermostat_config(conn, tc)
    assert _targets(await engine._arrive(conn, [], now=MON)) == [(76.0, "arrival")]
    # The zone default stands in for a room with no temperature of its own.
    tc.min_setpoint, tc.default_temp = 60.0, 72.0
    await db.upsert_thermostat_config(conn, tc)
    room.system_wide_temp = None
    await db.upsert_room(conn, room)
    assert _targets(await engine._arrive(conn, [], now=MON)) == [(72.0, "arrival")]
    await conn.close()


@pytest.mark.asyncio
async def test_what_is_left_alone(monkeypatch):
    conn, engine, room, temps = await _setup(monkeypatch)
    hold = ActiveRoom(room=room, target_temp=66.0, source="override")
    band = ActiveRoom(room=room, target_temp=70.0, source="house", heat_to=70.0, cool_to=78.0)
    # A hold, a house band that already asks for as much, a call waiting to coast.
    assert await engine._arrive(conn, [hold], now=MON) == [hold]
    assert await engine._arrive(conn, [band], now=MON) == [band]
    engine._coast_wait = {room.id: (MON, "heating", 70.0)}
    assert await engine._arrive(conn, [], now=MON) == []
    engine._coast_wait = {}
    # Nor is a run started while any call in the zone is waiting to coast.
    engine._coast_wait = {"another-room": (MON, "cooling", 74.0)}
    assert await engine._arrive(conn, [], now=MON) == []
    engine._coast_wait = {}
    # No reading.
    temps["now"] = None
    assert await engine._arrive(conn, [], now=MON) == []
    temps["now"] = 64.0
    # The weather, the thermostat, the strips, the building's side, a run the other way.
    engine._read_outside_temp = AsyncMock(return_value=75.0)
    assert await engine._arrive(conn, [], now=MON) == []
    engine._read_outside_temp = AsyncMock(return_value=None)  # not known: not held against it
    assert _targets(await engine._arrive(conn, [], now=MON)) == [(70.0, "arrival")]
    engine._ha.get_state.return_value = {"state": "cool", "attributes": {}}
    assert await engine._arrive(conn, [], now=MON) == []
    engine._ha.get_state.return_value = {"state": "heat", "attributes": {}}
    engine._hp_strips = True
    assert await engine._arrive(conn, [], now=MON) == []
    engine._hp_strips = False
    engine._get_building_side = lambda: ("cooling", True)
    assert await engine._arrive(conn, [], now=MON) == []
    engine._get_building_side = lambda: ("cooling", False)  # only watched
    assert len(await engine._arrive(conn, [], now=MON)) == 1
    engine._get_building_side = None
    engine._state, engine._cycle_mode = CycleState.RUNNING, "cooling"
    assert await engine._arrive(conn, [], now=MON) == []
    engine._cycle_mode = "heating"  # a run the same way may be joined
    assert len(await engine._arrive(conn, [], now=MON)) == 1
    engine._state = CycleState.IDLE
    # The thermostat itself already reads past the target: it would refuse the cycle.
    engine._thermo_ambient_f = lambda: 70.6
    assert await engine._arrive(conn, [], now=MON) == []
    engine._thermo_ambient_f = lambda: 70.4
    assert len(await engine._arrive(conn, [], now=MON)) == 1
    engine._thermo_ambient_f = lambda: None
    assert len(await engine._arrive(conn, [], now=MON)) == 1
    # A sensor that reads low by a known amount is corrected before it is judged.
    room.temp_offset = 6.0
    await db.upsert_room(conn, room)
    assert await engine._arrive(conn, [], now=MON) == []  # 64 + 6 is 70: warm enough
    room.temp_offset = 0.0
    await db.upsert_room(conn, room)
    # The room's switches, and a room that does not follow occupancy at all.
    await house.set_switches(conn, room.id, {"in_use": False})
    assert await engine._arrive(conn, [], now=MON) == []
    await house.set_switches(conn, room.id, {"in_use": True, "use_presence": False})
    assert await engine._arrive(conn, [], now=MON) == []
    await house.set_switches(conn, room.id, {"use_presence": True})
    room.presence_holdover_hours = 0
    await db.upsert_room(conn, room)
    assert await engine._arrive(conn, [], now=MON) == []
    room.presence_holdover_hours, room.system_wide_temp = 2.0, None
    await db.upsert_room(conn, room)
    assert await engine._arrive(conn, [], now=MON) == []  # no temperature for occupancy
    room.system_wide_temp = 70.0
    await db.upsert_room(conn, room)
    # A schedule that has the hour: Start Rooms Early is the one for that.
    block = Schedule.create(
        room_id=room.id,
        days_of_week=[0],
        start_time=time(14, 0),
        end_time=time(16, 0),
        target_temp=68.0,
    )
    await db.upsert_schedule(conn, block)
    assert await engine._arrive(conn, [], now=MON) == []
    await house.set_switches(conn, room.id, {"use_schedules": False})
    assert len(await engine._arrive(conn, [], now=MON)) == 1
    # A room with no usual hours.
    engine._usual_hours = (MON, {})
    assert await engine._arrive(conn, [], now=MON) == []
    await conn.close()


@pytest.mark.asyncio
async def test_watch_only_says_what_it_would_do_and_off_does_nothing(monkeypatch):
    conn, engine, room, _temps = await _setup(monkeypatch, level="watch")
    assert await engine._arrive(conn, [], now=MON) == []
    assert _said(engine)[0].startswith("Would get (watching only) Bunk Room ready for 14:00")
    assert engine._optional_replaced == {}
    await learning.update_settings(conn, {"arrival_level": 0})
    assert await engine._arrive(conn, [], now=MON) == [] and engine._usual_hours is None
    engine._logger = None
    await learning.update_settings(conn, {"arrival_level": 2})
    assert await engine._arrive(conn, []) == []  # the clock's own "now" is accepted
    engine._usual_hours = (MON, {room.id: USUAL})
    assert len(await engine._arrive(conn, [], now=MON)) == 1
    await conn.close()


@pytest.mark.asyncio
async def test_a_room_that_started_a_run_is_kept_in_it_to_the_end(monkeypatch):
    conn, engine, room, temps = await _setup(monkeypatch)
    asked = await engine._arrive(conn, [], now=MON)
    engine._state, engine._cycle_mode = CycleState.RUNNING, "heating"
    engine._active_rooms = {room.id: asked[0]}
    assert engine.arrival_rooms == [room.id]
    assert engine._arrival_until == {room.id: MON + timedelta(minutes=50)}
    # Kept while the hour may still be used, at the target it was asked to.
    # (The one asked for, not one Eco has since relaxed.)
    temps["now"] = 66.0
    soon = MON + timedelta(minutes=40)
    assert _targets(await engine._arrive(conn, [], now=soon)) == [(70.0, "arrival")]
    engine._active_rooms[room.id].requested_target = 71.0
    assert _targets(await engine._arrive(conn, [], now=soon)) == [(71.0, "arrival")]
    engine._active_rooms[room.id].requested_target = None
    # Half an hour into the hour with nobody there, the run is wound up: the
    # room is taken to be where it should be, so the run ends by the usual
    # rules. Not before its minimum runtime, and once its vent has closed
    # there is nothing left to wind up.
    later = MON + timedelta(minutes=51)
    engine._cycle_runtime_satisfied = lambda _tc, now=None: False
    assert _targets(await engine._arrive(conn, [], now=later)) == [(70.0, "arrival")]
    engine._cycle_runtime_satisfied = lambda _tc, now=None: True
    assert _targets(await engine._arrive(conn, [], now=later)) == [(66.0, "arrival")]
    room.temp_offset = 1.0
    await db.upsert_room(conn, room)
    assert _targets(await engine._arrive(conn, [], now=later)) == [(67.0, "arrival")]
    room.temp_offset = 0.0
    await db.upsert_room(conn, room)
    engine._room_cycle_states = {room.id: SimpleNamespace(vent_closed_at=later)}
    assert _targets(await engine._arrive(conn, [], now=later)) == [(70.0, "arrival")]
    engine._room_cycle_states = {room.id: SimpleNamespace(vent_closed_at=None)}
    temps["now"] = None
    assert _targets(await engine._arrive(conn, [], now=later)) == [(70.0, "arrival")]
    temps["now"] = 66.0
    # The same when this is switched off, or watched only, mid-run, and after
    # a restart has lost track of the hour.
    for level in (0, 1):
        await learning.update_settings(conn, {"arrival_level": level})
        assert _targets(await engine._arrive(conn, [], now=soon)) == [(66.0, "arrival")]
    await learning.update_settings(conn, {"arrival_level": 2})
    assert _targets(await engine._arrive(conn, [], now=soon)) == [(70.0, "arrival")]
    engine._arrival_until = {}
    assert _targets(await engine._arrive(conn, [], now=soon)) == [(66.0, "arrival")]
    # Someone arrives: occupancy has the room from here.
    here = ActiveRoom(room=room, target_temp=70.0, source="presence")
    assert await engine._arrive(conn, [here], now=later) == [here]
    engine._state = CycleState.IDLE
    assert await engine._arrive(conn, [], now=later) == []
    assert engine._arrival_until == {}
    await conn.close()


@pytest.mark.asyncio
async def test_the_lead_comes_from_the_rooms_model_once_it_has_one(monkeypatch):
    conn, engine, room, _temps = await _setup(monkeypatch)
    minutes = {"to": 60}
    model = SimpleNamespace(
        fitted_at=MON - timedelta(days=1),
        learned={"heat": True, "cool": False},
        minutes_to=lambda *_a, **_k: minutes["to"],
    )
    monkeypatch.setattr(room_model, "load", AsyncMock(return_value={room.id: model}))
    early = MON - timedelta(minutes=30)  # 50 minutes ahead
    assert len(await engine._arrive(conn, [], now=early)) == 1
    assert engine._logger.log.await_args.args[3]["lead_min"] == 60
    # The model was fitted on raw readings, so it is asked in those.
    seen = {}
    model.minutes_to = lambda start, target, *_a, **_k: (
        seen.update(start=start, target=target) or 60
    )
    room.temp_offset = 2.0
    await db.upsert_room(conn, room)
    await engine._arrive(conn, [], now=early)
    assert seen == {"start": 64.0, "target": 68.0}
    room.temp_offset = 0.0
    await db.upsert_room(conn, room)
    model.minutes_to = lambda *_a, **_k: minutes["to"]
    # A room that would not get there in time is given the longest lead, and no more.
    minutes["to"] = None
    assert len(await engine._arrive(conn, [], now=MON - timedelta(minutes=70))) == 1
    assert await engine._arrive(conn, [], now=MON - timedelta(minutes=95)) == []
    # A quick room is not started sooner than it needs.
    minutes["to"] = 5
    assert await engine._arrive(conn, [], now=MON) == []
    assert len(await engine._arrive(conn, [], now=MON + timedelta(minutes=6))) == 1
    # A model gone stale, one that has not learned this direction, or no
    # outdoor reading to ask it with: the fixed half hour.
    minutes["to"] = 60
    for change in ("stale", "unlearned", "outside"):
        if change == "stale":
            model.fitted_at = MON - timedelta(days=room_model.EARLY_START_STALE_DAYS + 1)
        elif change == "unlearned":
            model.fitted_at, model.learned = MON, {"heat": False, "cool": True}
        else:
            model.learned = {"heat": True, "cool": True}
            engine._read_outside_temp = AsyncMock(return_value=None)
        assert await engine._arrive(conn, [], now=early) == []
    model.fitted_at = None
    assert await engine._arrive(conn, [], now=early) == []
    await conn.close()


@pytest.mark.asyncio
async def test_usual_hours_are_read_now_and_then_not_every_minute(monkeypatch):
    conn, engine, room, _temps = await _setup(monkeypatch)
    read = AsyncMock(return_value={room.id: USUAL})
    monkeypatch.setattr(suggestions, "usual_hours", read)
    engine._usual_hours = None
    assert len(await engine._arrive(conn, [], now=MON)) == 1
    await engine._arrive(conn, [], now=MON + timedelta(minutes=5))
    assert read.await_count == 1 and read.await_args.args[1] == [room.id]
    # Again after six hours, and if the clock has gone backwards.
    await engine._arrive(conn, [], now=MON + arrivals.REFRESH)
    await engine._arrive(conn, [], now=MON)
    assert read.await_count == 3
    await conn.close()
