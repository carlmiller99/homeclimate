"""Stop Early to Avoid Overshoot: what is learned from a room's closes, and when it is used."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from backend import db, learning, stop_early
from backend.engine.room_manager import ActiveRoom
from backend.learning import RoomSample
from backend.models import CycleLog, Room, RoomCycleState

from .test_cycle_engine import _make_engine, _make_ha
from .test_heat_pump import THERMO_ID, _conn

NOW = datetime(2026, 2, 2, 12, 0, tzinfo=UTC)


def test_the_lead_is_the_run_on_most_closes_reached():
    assert stop_early.lead_from([0.9, 0.8, 0.7, 0.6]) == 0.0  # too few closes
    # Sorted: 0.4 0.6 0.7 0.8 0.9 1.0 1.1 1.2 -> the one a quarter of the way up.
    assert stop_early.lead_from([1.2, 0.4, 0.9, 0.7, 0.6, 1.0, 0.8, 1.1]) == 0.7
    assert stop_early.lead_from([0.1] * 6) == 0.0  # not worth acting on
    assert stop_early.lead_from([4.0] * 6) == stop_early.MAX_LEAD_F


def test_the_lead_used_is_at_most_half_the_deadband():
    """The other half is the room's hysteresis: it may dip without being opened again."""
    table = {"den": {"heating": {"lead": 0.9, "runs": 8}, "cooling": {"lead": 0.0, "runs": 2}}}
    assert stop_early.lead(table, "den", "heating", 2.0) == 0.9
    assert stop_early.lead(table, "den", "heating", 1.0) == 0.5
    assert stop_early.lead(table, "den", "heating", 0.5) == 0.25
    assert stop_early.lead(table, "den", "heating", 0.3) == 0.0  # too small to matter
    assert stop_early.lead(table, "den", "cooling", 2.0) == 0.0
    assert stop_early.lead(table, "loft", "heating", 2.0) == 0.0
    assert stop_early.lead({"den": {"heating": "bad"}}, "den", "heating", 2.0) == 0.0


@pytest.mark.parametrize(
    "mode, temp, start, expected",
    [
        ("heating", 69.5, 67.0, True),  # within the lead, and it has gained more than the lead
        ("heating", 69.3, 67.0, False),  # not close enough yet
        ("heating", 69.5, 69.2, False),  # began too close to have built up any run-on
        ("heating", 69.5, None, False),  # where it began is not known
        ("cooling", 70.5, 73.0, True),
        ("cooling", 70.7, 73.0, False),
        ("cooling", 70.5, 70.8, False),
        ("fan", 69.9, 60.0, False),
    ],
)
def test_when_a_room_is_closed_early(mode, temp, start, expected):
    assert stop_early.stops_now(0.6, mode, temp, 70.0, start) is expected
    assert stop_early.stops_now(0.0, mode, temp, 70.0, start) is False


async def _close(conn, room_id, when, mode="heating", role="active", at_close=None):
    log = CycleLog.create(thermostat_entity_id=THERMO_ID, mode=mode, rooms_json="{}")
    log.started_at = when - timedelta(minutes=20)
    await db.insert_cycle_log(conn, log)
    await db.upsert_room_cycle_state(
        conn,
        RoomCycleState(
            cycle_id=log.id,
            room_id=room_id,
            target_temp=70,
            vent_closed_at=when,
            role=role,
            temp_at_end=at_close,
        ),
    )


async def _readings(conn, room_id, when, temps, **flags):
    """A reading every five minutes from ``when``."""
    await learning.store(
        conn,
        [
            RoomSample(
                ts=when + timedelta(minutes=5 * i),
                room_id=room_id,
                thermostat_entity_id=THERMO_ID,
                room_temp=t,
                zone_temp=70.0,
                outside_temp=40.0,
                hvac_action=flags.get("actions", {}).get(i, "idle"),
                aux_heat=False,
                vent_open=flags.get("vent", 0.0),
                zone_vent_open=0.5,
                occupied=None,
                opening=flags.get("opening"),
                fireplace=flags.get("fireplace"),
            )
            for i, t in enumerate(temps)
        ],
    )


@pytest.mark.asyncio
async def test_learning_reads_the_half_hour_after_each_close():
    conn = await _conn()
    room = Room.create(name="Den", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    rise = [69.0, 69.3, 69.6, 69.8, 69.7, 69.6, 69.5]  # runs on 0.8
    for day in range(1, 7):
        at = NOW - timedelta(days=day)
        await _readings(conn, room.id, at, rise)
        await _close(conn, room.id, at + timedelta(seconds=30))
    # Left out: a door open, a fire lit, a half hour with readings missing, a
    # close with no reading near it, an overflow room, and one too long ago.
    at = NOW - timedelta(days=8)
    await _readings(conn, room.id, at, [69.0, 72.0, 72.0, 72.0, 72.0, 72.0, 72.0], opening=True)
    await _close(conn, room.id, at)
    at = NOW - timedelta(days=9)
    await _readings(conn, room.id, at, [69.0, 72.0, 72.0, 72.0, 72.0, 72.0, 72.0], fireplace=True)
    await _close(conn, room.id, at)
    at = NOW - timedelta(days=10)
    await _readings(conn, room.id, at, [69.0, 72.0, 72.0])
    await _close(conn, room.id, at)
    await _close(conn, room.id, NOW - timedelta(days=11))
    at = NOW - timedelta(days=12)
    await _readings(conn, room.id, at, [69.0, 72.0, 72.0, 72.0, 72.0, 72.0, 72.0])
    await _close(conn, room.id, at, role="overflow")
    at = NOW - timedelta(days=40)
    await _readings(conn, room.id, at, [69.0, 72.0, 72.0, 72.0, 72.0, 72.0, 72.0])
    await _close(conn, room.id, at)
    # Cooling is learned by itself, and counts a fall.
    fall = [72.0, 71.6, 71.5, 71.7, 71.8, 71.9, 72.0]
    for day in range(13, 18):
        at = NOW - timedelta(days=day)
        await _readings(conn, room.id, at, fall)
        await _close(conn, room.id, at, mode="cooling")

    # Where the run recorded the temperature at the close itself, that is the
    # starting point: the reading before it (68.0 here) is stale.
    other = Room.create(name="Loft", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, other)
    for day in range(1, 6):
        at = NOW - timedelta(days=day)
        await _readings(conn, other.id, at, [68.0, 69.4, 69.5, 69.5, 69.4, 69.3, 69.2])
        await _close(conn, other.id, at + timedelta(minutes=4), at_close=69.1)
    # A half hour cut short by the next run: only what came before it counts,
    # and one cut short at once says nothing.
    third = Room.create(name="Study", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, third)
    for day in range(1, 6):
        at = NOW - timedelta(days=day)
        await _readings(
            conn,
            third.id,
            at,
            [69.0, 69.2, 69.3, 71.0, 72.0, 72.0, 72.0],
            actions={3: "heating", 4: "heating"},
            vent=1.0,
        )
        await _close(conn, third.id, at)
    at = NOW - timedelta(days=6)
    await _readings(
        conn,
        third.id,
        at,
        [69.0, 72.0, 72.0, 72.0, 72.0, 72.0, 72.0],
        actions={1: "heating"},
        vent=1.0,
    )
    await _close(conn, third.id, at)

    table = await stop_early.learn(conn, now=NOW)
    assert table.pop(other.id)["heating"] == {"lead": 0.4, "runs": 5}
    assert table.pop(third.id)["heating"] == {"lead": 0.3, "runs": 5}
    assert table == {
        room.id: {
            "heating": {"lead": 0.8, "runs": 6},
            "cooling": {"lead": 0.5, "runs": 5},
        }
    }
    assert (await stop_early.load(conn))[room.id] == table[room.id]
    await db.set_system_setting(conn, stop_early.KEY, "not json")
    assert await stop_early.load(conn) == {}
    await db.set_system_setting(conn, stop_early.KEY, json.dumps([1]))
    assert await stop_early.load(conn) == {}
    await db.set_system_setting(conn, stop_early.KEY, "")
    assert await stop_early.load(conn) == {}
    await conn.close()


async def _engine(level, lead=0.6):
    conn = await _conn()
    room = Room.create(name="Den", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    await learning.update_settings(conn, {"stop_early_level": level})
    await db.set_system_setting(
        conn, stop_early.KEY, json.dumps({room.id: {"heating": {"lead": lead, "runs": 9}}})
    )
    engine = _make_engine(_make_ha(ambient=69.0, hvac_mode="heat", hvac_action="heating"))
    engine._logger = AsyncMock()
    return conn, engine, room


@pytest.mark.asyncio
async def test_what_the_engine_reads_each_tick_and_who_is_left_alone():
    conn, engine, room = await _engine(2)
    await engine._read_stop_early(conn, False)
    assert engine._stop_early_level == "on"
    state = RoomCycleState(cycle_id="c1", room_id=room.id, target_temp=70.0, temp_at_start=67.0)
    following = ActiveRoom(room=room, target_temp=70.0, source="schedule")
    # The zone's deadband is 0.5, so the 0.6 learned is used as 0.25: half of it.
    assert engine._stops_early(following, state, 69.75, "heating")
    assert not engine._stops_early(following, state, 69.7, "heating")
    # The room's offset moves both where it is and where it began.
    room.temp_offset = 0.3
    assert engine._stops_early(following, state, 69.45, "heating")
    room.temp_offset = 0.0
    # A room with its own wider deadband may use more of what it learned.
    wide = ActiveRoom(room=room, target_temp=70.0, source="schedule", deadband_override=1.0)
    assert engine._stops_early(wide, state, 69.5, "heating")
    assert not engine._stops_early(wide, state, 69.4, "heating")
    # Once in a run: a room that was closed and opened again goes all the way.
    again = RoomCycleState(
        cycle_id="c1", room_id=room.id, target_temp=70.0, temp_at_start=67.0, reached_at=NOW
    )
    assert not engine._stops_early(following, again, 69.9, "heating")
    # Safety protection is never cut short; nor a room with no starting temperature.
    assert not engine._stops_early(
        ActiveRoom(room=room, target_temp=70.0, source="safety"), state, 69.9, "heating"
    )
    blind = RoomCycleState(cycle_id="c1", room_id=room.id, target_temp=70.0)
    assert not engine._stops_early(following, blind, 69.9, "heating")
    # Off during a trip, and when switched off.
    await engine._read_stop_early(conn, True)
    assert engine._stop_early_level == "off"
    assert not engine._stops_early(following, state, 69.9, "heating")
    await learning.update_settings(conn, {"stop_early_level": 0})
    await engine._read_stop_early(conn, False)
    assert engine._stop_early_level == "off" and engine._stop_early_table == {}
    await conn.close()


def _open_vents(engine):
    engine._ha.get_state.side_effect = lambda eid: (
        {
            "state": "cool",
            "attributes": {
                "current_temperature": 70.0,
                "temperature": 68.0,
                "hvac_action": "cooling",
            },
        }
        if eid == THERMO_ID
        else {"state": "open", "attributes": {}}
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("level, closes", [(1, False), (2, True)])
async def test_a_running_room_is_closed_short_of_its_target_only_when_on(level, closes):
    """A cooling run to 72 that began at 75: at 72.2 the room is within its 0.25 lead."""
    from .test_cycle_diagnostics import _running_cycle_with_vent

    engine, conn, cycle, room = await _running_cycle_with_vent()
    engine._logger = AsyncMock()
    _open_vents(engine)
    await learning.update_settings(conn, {"stop_early_level": level})
    await db.set_system_setting(
        conn, stop_early.KEY, json.dumps({room.id: {"cooling": {"lead": 0.9, "runs": 7}}})
    )
    await engine._read_stop_early(conn, False)
    state = engine._room_cycle_states[room.id]
    state.temp_at_start = 75.0
    ar = engine._active_rooms[room.id]
    tc = await db.get_thermostat_config(conn, THERMO_ID)

    engine._ha.get_numeric_state.return_value = 72.2
    # Every judge of "is this room done" agrees, or the run could not end.
    assert engine._all_active_rooms_satisfied("cooling") is closes
    read = engine._get_avg_temp
    engine._get_avg_temp = lambda room, refresh=True: 72.2
    assert engine._done_in_this_run(ar, tc) is closes
    engine._get_avg_temp = read
    await engine._monitor_rooms(conn, "cooling")
    await engine._monitor_rooms(conn, "cooling")

    said = [c.args[2] for c in engine._logger.log.await_args_list if "Stop Early" in c.args[2]]
    verb = "closed" if closes else "would have closed"
    # Said once for the run, not on every look; and "closed" only once it has.
    assert said == [
        f"Stop Early {verb} {room.name}'s vent 0.2°F before its target; it usually runs on the rest"
    ]
    assert (state.vent_closed_at is not None) is closes
    events = await db.get_cycle_vent_events(conn, cycle.id)
    assert any(e.action == "closed_reached_target" for e in events) is closes
    await conn.close()


@pytest.mark.asyncio
async def test_a_room_not_yet_close_enough_runs_on_as_before():
    from .test_cycle_diagnostics import _running_cycle_with_vent

    engine, conn, _cycle, room = await _running_cycle_with_vent()
    engine._logger = AsyncMock()
    _open_vents(engine)
    await learning.update_settings(conn, {"stop_early_level": 2})
    await db.set_system_setting(
        conn, stop_early.KEY, json.dumps({room.id: {"cooling": {"lead": 0.9, "runs": 7}}})
    )
    await engine._read_stop_early(conn, False)
    engine._room_cycle_states[room.id].temp_at_start = 75.0
    engine._ha.get_numeric_state.return_value = 72.6
    await engine._monitor_rooms(conn, "cooling")
    assert engine._room_cycle_states[room.id].vent_closed_at is None
    assert not engine._all_active_rooms_satisfied("cooling")
    await conn.close()


@pytest.mark.asyncio
async def test_closes_are_read_as_utc_whatever_zone_the_house_is_in(monkeypatch):
    """Close times are stored without a zone. The add-on runs with TZ set to the
    house's zone, and must not shift them by its offset."""
    import time

    monkeypatch.setenv("TZ", "America/Chicago")
    time.tzset()
    try:
        conn = await _conn()
        room = Room.create(name="Den", thermostat_entity_id=THERMO_ID)
        await db.upsert_room(conn, room)
        for day in range(1, 7):
            at = NOW - timedelta(days=day)
            await _readings(conn, room.id, at, [69.0, 69.3, 69.6, 69.8, 69.7, 69.6, 69.5])
            await _close(conn, room.id, at + timedelta(seconds=30))
        table = await stop_early.learn(conn, now=NOW)
        assert table[room.id]["heating"] == {"lead": 0.8, "runs": 6}
        await conn.close()
    finally:
        monkeypatch.undo()
        time.tzset()
