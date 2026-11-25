"""Coasting inside the cycle engine: which calls wait, for how long, and what ends a wait."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from backend import coasting, db, forecast, learning, tz, zones
from backend import room_model as rm
from backend.engine.cycle_engine import CycleState
from backend.engine.room_manager import ActiveRoom
from backend.models import Room

from .test_cycle_engine import _make_engine, _make_ha
from .test_heat_pump import THERMO_ID, _conn

pytestmark = pytest.mark.asyncio

NOW = datetime(2026, 4, 6, 8, 0, tzinfo=UTC)


async def _setup(monkeypatch, *, temp=68.4, outside=80.0, level=2, loss=0.6, strip=True):
    """One room asked for 70 °F, half a degree past its deadband, on a warm morning."""
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)
    conn = await _conn()
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    await learning.update_settings(conn, {"coast_level": level})
    await conn.execute(
        "INSERT INTO room_models(room_id, fitted_at, windows, loss, pull, heat, cool, drift,"
        " heat_hours, cool_hours, out_spread, rmse) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (room.id, int(NOW.timestamp()), 600, loss, 0.0, 3.0, -3.0, 0.0, 10.0, 10.0, 8.0, 0.2),
    )
    await zones.update_zone_profile(
        conn, THERMO_ID, {"backup_heat": "electric" if strip else "gas"}
    )
    await conn.commit()
    engine = _make_engine(_make_ha(ambient=temp, hvac_mode="heat", hvac_action="idle"))
    engine._logger = AsyncMock()
    temps = {"now": temp}
    engine._get_avg_temp = lambda _room, **_k: temps["now"]
    engine._read_outside_temp = AsyncMock(return_value=outside)
    active = [ActiveRoom(room=room, target_temp=70.0, source="schedule")]
    return conn, engine, room, active, temps


async def _at(engine, conn, active, when):
    """One tick at ``when``, as the next minute's tick after the one before it."""
    engine._coast_seen = when - timedelta(minutes=1)
    return await engine._coast(conn, active, now=when)


def _said(engine) -> list[str]:
    return [c.args[2] for c in engine._logger.log.await_args_list]


async def test_a_call_waits_while_the_room_is_drifting_to_its_target(monkeypatch):
    conn, engine, room, active, temps = await _setup(monkeypatch)
    assert await _at(engine, conn, active, NOW) == []
    assert engine.coasting_rooms == {
        room.id: {"since": NOW.isoformat(), "mode": "heating", "target": 70.0}
    }
    assert _said(engine) == [
        "Letting Bunk Room coast: it should be within reach of 70°F on its own in about"
        " 10 min (waiting up to 135)"
    ]
    # Still waiting a few minutes on; nothing more is said.
    temps["now"] = 68.9
    assert await _at(engine, conn, active, NOW + timedelta(minutes=5)) == []
    assert len(_said(engine)) == 1
    # It gets there: the room is back among the others, asking for nothing.
    temps["now"] = 69.6
    assert await _at(engine, conn, active, NOW + timedelta(minutes=12)) == active
    assert engine.coasting_rooms == {}
    assert _said(engine)[-1] == "Bunk Room reached 70°F by coasting after 12 min: a start avoided"
    assert await coasting.misses(conn, now=NOW) == 0
    await conn.close()


async def test_a_wait_that_runs_out_starts_the_equipment_and_the_call_is_not_held_twice(
    monkeypatch,
):
    conn, engine, room, active, _temps = await _setup(monkeypatch, strip=False)
    assert await _at(engine, conn, active, NOW) == []
    assert "waiting up to 45" in _said(engine)[0]  # not strip heat: the short wait
    # Half an hour on and no warmer: the model still says ten minutes, so it waits.
    assert await _at(engine, conn, active, NOW + timedelta(minutes=30)) == []
    late = NOW + timedelta(minutes=46)
    assert await _at(engine, conn, active, late) == active
    assert (
        _said(engine)[-1] == "Bunk Room did not reach 70°F by coasting (46 min); starting heating"
    )
    # 1.6 °F short is a miss.
    assert await coasting.misses(conn, now=late) == 1
    # The same call is not made to wait again, however the model reads.
    assert await _at(engine, conn, active, late + timedelta(minutes=1)) == active
    assert engine.coasting_rooms == {}
    # Once the call has ended, and half an hour has passed, the next one is new.
    engine._get_avg_temp = lambda _room, **_k: 70.0
    await _at(engine, conn, active, late + timedelta(minutes=20))
    engine._get_avg_temp = lambda _room, **_k: 68.4
    assert await _at(engine, conn, active, late + timedelta(minutes=25)) == active
    assert await _at(engine, conn, active, late + timedelta(minutes=60)) == []
    await conn.close()


async def test_a_room_two_degrees_off_is_never_kept_waiting(monkeypatch):
    conn, engine, _room, active, temps = await _setup(monkeypatch, temp=68.0)
    assert await _at(engine, conn, active, NOW) == active
    assert _said(engine) == []
    # One that slips to the floor while waiting is started at once, and counted.
    temps["now"] = 68.4
    assert await _at(engine, conn, active, NOW) == []
    temps["now"] = 67.9
    assert await _at(engine, conn, active, NOW + timedelta(minutes=5)) == active
    assert await coasting.misses(conn, now=NOW + timedelta(minutes=5)) == 1
    await conn.close()


async def test_a_wait_ends_early_when_the_model_no_longer_expects_it(monkeypatch):
    conn, engine, _room, active, temps = await _setup(monkeypatch)
    assert await _at(engine, conn, active, NOW) == []
    # A front comes through. 1.1 °F short is not a miss; it just starts.
    engine._read_outside_temp = AsyncMock(return_value=40.0)
    temps["now"] = 68.9
    assert await _at(engine, conn, active, NOW + timedelta(minutes=5)) == active
    assert await coasting.misses(conn, now=NOW) == 0
    await conn.close()


async def test_the_third_miss_in_a_week_goes_back_to_watch_only(monkeypatch):
    conn, engine, room, active, temps = await _setup(monkeypatch)
    await coasting.record_miss(conn, now=NOW - timedelta(days=1))
    await coasting.record_miss(conn, now=NOW - timedelta(days=2))
    other = Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, other)
    await conn.execute(
        "INSERT INTO room_models SELECT ?, fitted_at, windows, loss, pull, heat, cool, drift,"
        " heat_hours, cool_hours, out_spread, rmse, pinned, sun, sun_hours FROM room_models",
        (other.id,),
    )
    await conn.commit()
    both = [*active, ActiveRoom(room=other, target_temp=70.0, source="presence")]
    assert await _at(engine, conn, both, NOW) == []
    engine._get_avg_temp = lambda r, **_k: 67.9 if r.id == room.id else 68.4
    later = NOW + timedelta(minutes=5)
    # The first room's miss switches it back; the second is let go too.
    assert await _at(engine, conn, both, later) == both
    assert (await learning.get_settings(conn))["coast_level"] == 1
    assert engine.coasting_rooms == {}
    warning = engine._logger.log.await_args_list[-1]
    assert warning.args[0] == "warning" and warning.args[2] == (
        "Let Rooms Coast has gone back to Watch Only: three waits this week ended with a room"
        " 1.5°F or more from its target"
    )
    # The second room has had its wait: nothing more is said about it.
    assert await _at(engine, conn, both, later + timedelta(minutes=1)) == both
    assert engine._logger.log.await_args_list[-1] is warning
    await conn.close()


async def test_watching_only_says_once_what_it_would_do_and_holds_nothing(monkeypatch):
    conn, engine, _room, active, _temps = await _setup(monkeypatch, level=1)
    for minute in range(3):
        assert await _at(engine, conn, active, NOW + timedelta(minutes=minute)) == active
    assert len(_said(engine)) == 1 and _said(engine)[0].startswith(
        "Would let (watching only) Bunk Room coast"
    )
    assert engine.coasting_rooms == {}
    await conn.close()


async def test_which_calls_are_left_alone(monkeypatch):
    conn, engine, room, active, temps = await _setup(monkeypatch)

    def one(**changes):
        return [ActiveRoom(**{"room": room, "target_temp": 70.0, "source": "schedule", **changes})]

    # A hold, a band, and a room that asks for nothing.
    for same in (
        one(source="override"),
        one(source="house", heat_to=70.0, cool_to=76.0),
        one(heat_to=70.0, cool_to=76.0),
        one(target_temp=68.5),
    ):
        assert await _at(engine, conn, same, NOW) == same
    # A room being got ready early.
    engine._early_latch = {room.id: (NOW, 70.0, "heating")}
    assert await _at(engine, conn, active, NOW) == active
    engine._early_latch = {}
    engine._hp_latch = {room.id: (NOW, 70.0)}
    assert await _at(engine, conn, active, NOW) == active
    engine._hp_latch = {}
    # No reading from the room, or from outside.
    temps["now"] = None
    assert await _at(engine, conn, active, NOW) == active
    temps["now"] = 68.4
    engine._read_outside_temp = AsyncMock(return_value=None)
    assert await _at(engine, conn, active, NOW) == active
    engine._read_outside_temp = AsyncMock(return_value=80.0)
    # Colder outside than in: it will not drift there.
    engine._read_outside_temp = AsyncMock(return_value=40.0)
    assert await _at(engine, conn, active, NOW) == active
    engine._read_outside_temp = AsyncMock(return_value=80.0)
    # A model too old to trust, or none.
    await conn.execute("UPDATE room_models SET fitted_at = 1")
    await conn.commit()
    assert await _at(engine, conn, active, NOW) == active
    await conn.execute("UPDATE room_models SET room_id = 'someone-else'")
    await conn.commit()
    assert await _at(engine, conn, active, NOW) == active
    await conn.execute("DELETE FROM room_models")
    await conn.commit()
    assert await _at(engine, conn, active, NOW) == active
    assert _said(engine) == []
    await conn.close()


async def test_a_running_cycle_or_switching_it_off_lets_every_room_go(monkeypatch):
    conn, engine, _room, active, _temps = await _setup(monkeypatch)
    assert await _at(engine, conn, active, NOW) == []
    # Something else started the equipment: a waiting room is served with the rest.
    engine._state = CycleState.RUNNING
    assert await _at(engine, conn, active, NOW) == active
    assert engine.coasting_rooms == {}
    engine._state = CycleState.IDLE
    assert await _at(engine, conn, active, NOW) == active  # it has had its wait
    await learning.update_settings(conn, {"coast_level": 0})
    assert await _at(engine, conn, active, NOW) == active
    assert engine.coasting_rooms == {} and engine._coast_done == {}
    # No logger, and the real clock.
    await learning.update_settings(conn, {"coast_level": 2})
    engine._logger = None
    await conn.execute(
        "UPDATE room_models SET fitted_at = ?", (int(datetime.now(UTC).timestamp()),)
    )
    await conn.commit()
    assert await engine._coast(conn, active) == []
    await conn.close()


async def test_cooling_waits_too_and_uses_the_forecast_and_the_rooms_offset(monkeypatch):
    conn, engine, room, _active, temps = await _setup(monkeypatch, temp=71.6, outside=60.0)
    cool = [ActiveRoom(room=room, target_temp=70.0, source="presence", deadband_override=1.0)]
    assert await _at(engine, conn, cool, NOW) == []
    assert "waiting up to 45" in _said(engine)[0]  # strip heat makes no difference to cooling
    assert engine.coasting_rooms[room.id]["mode"] == "cooling"
    engine._coast_wait = {}
    # The forecast, corrected to the sensor, has it turning hot in minutes: no wait.
    await conn.execute(
        "INSERT INTO forecast_hours(at, temp, fetched_at) VALUES(?, ?, 0), (?, ?, 0)",
        (
            int(NOW.timestamp()),
            60 * forecast.TEMP_SCALE,
            int((NOW + timedelta(minutes=5)).timestamp()),
            95 * forecast.TEMP_SCALE,
        ),
    )
    await conn.commit()
    assert await _at(engine, conn, cool, NOW) == cool
    await conn.execute("DELETE FROM forecast_hours")
    await conn.commit()
    # A +1 °F offset: the room reads 71.6 °F from a sensor at 70.6 °F. The model
    # is asked about the sensor's own numbers.
    room.temp_offset = 1.0
    temps["now"] = 70.6
    assert await _at(engine, conn, cool, NOW) == []
    await conn.close()


async def test_through_the_engine_a_waiting_room_starts_nothing_until_its_wait_is_over(monkeypatch):
    from backend.engine import cycle_engine

    conn, engine, room, active, _temps = await _setup(monkeypatch, strip=False)
    monkeypatch.setattr(cycle_engine, "get_active_rooms", AsyncMock(return_value=active))
    engine._reset_setpoint_to_ambient = AsyncMock()
    engine._monitor_rooms = AsyncMock()
    started = AsyncMock()
    engine._start_or_update_cycle = started
    real = engine._coast
    clock = [NOW]
    engine._coast = lambda c, a, _now: real(c, a, now=clock[0])
    for _ in range(30):
        await engine._do_tick(conn)
        clock[0] += timedelta(minutes=1)
    started.assert_not_awaited()
    for _ in range(16):
        await engine._do_tick(conn)
        clock[0] += timedelta(minutes=1)
    assert set(started.await_args.args[1]) == {room.id} and started.await_args.args[2] == "heating"
    await conn.close()


async def test_a_wait_the_model_expects_to_end_badly_is_not_begun(monkeypatch):
    """A cold morning that turns hot later: it would arrive, but only after slipping too far."""
    conn, engine, _room, active, _temps = await _setup(monkeypatch, outside=55.0)
    await conn.execute(
        "INSERT INTO forecast_hours(at, temp, fetched_at) VALUES(?, ?, 0), (?, ?, 0)",
        (
            int(NOW.timestamp()),
            55 * forecast.TEMP_SCALE,
            int((NOW + timedelta(hours=2)).timestamp()),
            100 * forecast.TEMP_SCALE,
        ),
    )
    await conn.commit()
    model = (await rm.load(conn))[active[0].room.id]
    outlook = coasting.Outlook(NOW, 55.0, [(NOW, 55.0), (NOW + timedelta(hours=2), 100.0)])
    # Left to itself the model has it arriving, by way of 66 °F.
    assert coasting.minutes_alone(model, temp=68.4, goal=69.5, outlook=outlook, within_min=135)
    assert (
        coasting.minutes_alone(
            model, temp=68.4, goal=69.5, outlook=outlook, within_min=135, floor=68.5
        )
        is None
    )
    assert await _at(engine, conn, active, NOW) == active
    assert _said(engine) == []
    await conn.close()


async def test_a_wait_left_over_from_before_a_gap_is_dropped_and_is_not_a_miss(monkeypatch):
    """Vacation Mode, the system off, the thermostat away: coasting is not looked at meanwhile."""
    conn, engine, _room, active, temps = await _setup(monkeypatch)
    assert await _at(engine, conn, active, NOW) == []
    temps["now"] = 68.1  # three days on, the same call, well short
    back = NOW + timedelta(days=3)
    await conn.execute("UPDATE room_models SET fitted_at = ?", (int(back.timestamp()),))
    await conn.commit()
    engine._read_outside_temp = AsyncMock(return_value=40.0)
    assert await engine._coast(conn, active, now=back) == active
    assert await coasting.misses(conn, now=back) == 0
    assert len(_said(engine)) == 1  # nothing about "did not reach … (4320 min)"
    await conn.close()


async def test_a_wait_that_is_dropped_is_not_given_again(monkeypatch):
    conn, engine, _room, active, _temps = await _setup(monkeypatch)
    # The equipment starts for something else, then stops: no second wait.
    assert await _at(engine, conn, active, NOW) == []
    engine._state = CycleState.RUNNING
    assert await _at(engine, conn, active, NOW + timedelta(minutes=1)) == active
    engine._state = CycleState.IDLE
    assert await _at(engine, conn, active, NOW + timedelta(minutes=2)) == active
    assert await _at(engine, conn, active, NOW + timedelta(minutes=40)) == active
    await conn.close()
    # The outside sensor drops out for a minute: the same.
    conn, engine, _room, active, _temps = await _setup(monkeypatch)
    assert await _at(engine, conn, active, NOW) == []
    engine._read_outside_temp = AsyncMock(return_value=None)
    assert await _at(engine, conn, active, NOW + timedelta(minutes=1)) == active
    engine._read_outside_temp = AsyncMock(return_value=80.0)
    assert await _at(engine, conn, active, NOW + timedelta(minutes=2)) == active
    await conn.close()
    # Switched to Watch Only mid-wait: let go, and nothing is "reached" afterwards.
    conn, engine, _room, active, temps = await _setup(monkeypatch)
    assert await _at(engine, conn, active, NOW) == []
    await learning.update_settings(conn, {"coast_level": 1})
    assert await _at(engine, conn, active, NOW + timedelta(minutes=1)) == active
    assert engine.coasting_rooms == {}
    temps["now"] = 69.8
    await _at(engine, conn, active, NOW + timedelta(minutes=2))
    assert len(_said(engine)) == 1
    await conn.close()


async def test_a_reading_hovering_at_the_edge_does_not_start_wait_after_wait(monkeypatch):
    conn, engine, _room, active, temps = await _setup(monkeypatch)
    for minute in range(60):
        temps["now"] = 69.45 if minute % 2 == 0 else 69.55
        await _at(engine, conn, active, NOW + timedelta(minutes=minute))
    # One wait begun and reached each half hour at most, not one a minute.
    assert len(_said(engine)) == 4
    assert engine.get_zone_status().coasting_rooms == []
    await conn.close()


async def test_a_wait_that_vanishes_does_not_buy_the_room_another(monkeypatch):
    """A target nudged, a reading missed for a tick, a gap in the ticks: none restarts the wait."""
    conn, engine, room, active, temps = await _setup(monkeypatch, strip=False)
    held = 0
    for minute in range(300):
        when = NOW + timedelta(minutes=minute)
        kind = (minute // 40) % 3 if minute % 40 == 39 else None
        if kind == 0:
            temps["now"] = None  # the room's sensor misses a tick
        elif kind == 1:
            active[0].target_temp += 0.1  # the target is nudged
        left = await _at(engine, conn, active, when) if kind != 2 else active
        temps["now"] = 68.4 + (active[0].target_temp - 70.0)
        held += left == []
    # A wait of up to 45 minutes, then half an hour at least before another:
    # about half the time at most, where it used to be all of it.
    assert 30 < held < 160
    await conn.close()


async def test_a_gap_in_the_ticks_ends_a_wait_and_the_dashboard_stops_saying_coasting(monkeypatch):
    conn, engine, room, active, _temps = await _setup(monkeypatch)
    now = datetime.now(UTC)
    await conn.execute("UPDATE room_models SET fitted_at = ?", (int(now.timestamp()),))
    await conn.commit()
    assert await _at(engine, conn, active, now) == []
    assert engine.get_zone_status().coasting_rooms == [room.id]
    # Just inside five minutes it is the same wait; past it, the wait is over.
    assert await engine._coast(conn, active, now=now + timedelta(minutes=4)) == []
    assert await engine._coast(conn, active, now=now + timedelta(minutes=10)) == active
    assert await engine._coast(conn, active, now=now + timedelta(minutes=11)) == active
    # Coasting not looked at for a while (the system off): no badge meanwhile.
    engine._coast_wait = {room.id: (now, "heating", 70.0)}
    engine._coast_seen = now - timedelta(minutes=30)
    assert engine.get_zone_status().coasting_rooms == []
    engine._coast_seen = None
    assert engine.get_zone_status().coasting_rooms == []
    await conn.close()


async def test_watching_only_does_not_flood_the_log_at_the_edge_either(monkeypatch):
    conn, engine, _room, active, temps = await _setup(monkeypatch, level=1)
    for minute in range(60):
        temps["now"] = 69.45 if minute % 2 == 0 else 69.55
        assert await _at(engine, conn, active, NOW + timedelta(minutes=minute)) == active
    assert len(_said(engine)) == 2
    await conn.close()
