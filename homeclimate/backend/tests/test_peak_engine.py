"""Peak Hours inside the cycle engine: which rooms are banked, and to where."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend import db, forecast, peak, tz
from backend.engine.cycle_engine import CycleState
from backend.engine.room_manager import ActiveRoom
from backend.models import Room

from .test_cycle_engine import _make_engine, _make_ha
from .test_heat_pump import THERMO_ID, _conn

pytestmark = pytest.mark.asyncio

BANKING = datetime(2026, 7, 6, 13, 0, tzinfo=UTC)  # Monday, an hour before a 14:00 peak


async def _setup(monkeypatch, *, temp=75.5, outside=95.0, **settings):
    """One banded room; the engine counts as short of its minimum runtime unless told."""
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)
    conn = await _conn()
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    await peak.update(conn, {"enabled": True, **settings})
    engine = _make_engine(_make_ha(ambient=temp, hvac_mode="cool", hvac_action="idle"))
    temps = {"now": temp}
    engine._get_avg_temp = lambda _room, **_k: temps["now"]
    engine._read_outside_temp = AsyncMock(return_value=outside)
    engine._cycle_runtime_satisfied = lambda _tc, now=None: False
    band = [ActiveRoom(room=room, target_temp=68.0, source="house", heat_to=68.0, cool_to=76.0)]
    return conn, engine, room, band, temps


def _targets(active) -> list[tuple[float, str]]:
    return [(ar.target_temp, ar.source) for ar in active]


async def test_before_a_hot_peak_a_banded_room_is_cooled_into_its_band(monkeypatch):
    conn, engine, room, band, temps = await _setup(monkeypatch)
    # 75.5 °F in a 68 to 76 band, 95 °F outside: banked 2 °F in, to 74.
    assert _targets(await engine._bank(conn, band, now=BANKING)) == [(74.0, "bank")]
    # Asked, but nothing is running for it yet: it is not shown as banking.
    assert engine._bank_latch == {room.id: 74.0} and engine.bank_rooms == []
    # Already that cool: left to its band.
    temps["now"] = 74.2
    assert await engine._bank(conn, band, now=BANKING) == band
    # Not yet time, the peak under way, and a day that is not a peak day.
    temps["now"] = 75.5
    for when in (
        BANKING - timedelta(hours=1),
        BANKING + timedelta(hours=2),
        BANKING + timedelta(days=5),
    ):
        assert await engine._bank(conn, band, now=when) == band
    await conn.close()


async def test_before_a_cold_peak_it_is_warmed_instead_and_a_mild_one_does_nothing(monkeypatch):
    conn, engine, _room, band, _temps = await _setup(monkeypatch, temp=68.5, outside=30.0)
    assert _targets(await engine._bank(conn, band, now=BANKING)) == [(70.0, "bank")]
    # A heat pump expecting its strips does not bank heat with them.
    engine._balance_latch = {}
    engine._bank_latch = {}
    engine._hp_strips = True
    assert await engine._bank(conn, band, now=BANKING) == band
    engine._hp_strips = False
    engine._read_outside_temp = AsyncMock(return_value=72.0)
    assert await engine._bank(conn, band, now=BANKING) == band
    # The forecast for the peak hours decides, corrected or not, when there is one.
    await conn.execute(
        "INSERT INTO forecast_hours(at, temp, fetched_at) VALUES(?, ?, 0)",
        (int((BANKING + timedelta(hours=2)).timestamp()), 20 * forecast.TEMP_SCALE),
    )
    await conn.commit()
    assert _targets(await engine._bank(conn, band, now=BANKING)) == [(70.0, "bank")]
    await forecast.update_settings(conn, {"correct": False})
    assert _targets(await engine._bank(conn, band, now=BANKING)) == [(70.0, "bank")]
    await conn.close()


async def test_what_is_never_banked(monkeypatch):
    conn, engine, room, band, temps = await _setup(monkeypatch)
    # While a call in the zone is waiting to coast, no run is started to bank.
    engine._coast_wait = {"another-room": (BANKING, "heating", 70.0)}
    assert await engine._bank(conn, band, now=BANKING) == band
    engine._coast_wait = {}
    # A hold, banded or not, and a single target.
    for own in (
        [ActiveRoom(room=room, target_temp=70.0, source="override", heat_to=70.0, cool_to=76.0)],
        [ActiveRoom(room=room, target_temp=72.0, source="schedule")],
    ):
        assert await engine._bank(conn, own, now=BANKING) == own
    # Against the side the building is held to.
    engine._get_building_side = lambda: ("heating", True)
    assert await engine._bank(conn, band, now=BANKING) == band
    engine._get_building_side = lambda: ("heating", False)
    assert await engine._bank(conn, band, now=BANKING) != band
    engine._bank_latch = {}
    engine._get_building_side = None
    # No reading from the room.
    temps["now"] = None
    assert await engine._bank(conn, band, now=BANKING) == band
    temps["now"] = 75.5
    # Switched off.
    await peak.update(conn, {"enabled": False})
    assert await engine._bank(conn, band, now=BANKING) == band
    await conn.close()


async def test_a_banded_schedule_is_banked_too_within_the_zones_limits(monkeypatch):
    conn, engine, room, _band, _temps = await _setup(monkeypatch, temp=79.5, peak_depth=5)
    block = [
        ActiveRoom(
            room=room,
            target_temp=70.0,
            source="schedule",
            heat_to=70.0,
            cool_to=80.0,
            deadband_override=0.2,
        )
    ]
    assert _targets(await engine._bank(conn, block, now=BANKING)) == [(75.0, "bank")]
    # A heating bank that would pass the zone's maximum setpoint (80 °F) is held to it.
    engine._bank_latch = {}
    engine._read_outside_temp = AsyncMock(return_value=20.0)
    engine._get_avg_temp = lambda _room, **_k: 76.0
    high = [ActiveRoom(room=room, target_temp=78.0, source="house", heat_to=78.0, cool_to=90.0)]
    assert _targets(await engine._bank(conn, high, now=BANKING)) == [(80.0, "bank")]
    await conn.close()


async def test_a_run_begun_for_banking_is_not_cut_short_when_the_peak_begins(monkeypatch):
    conn, engine, room, band, temps = await _setup(monkeypatch)

    def running(target=74.0, **more):
        engine._state, engine._cycle_mode = CycleState.RUNNING, "cooling"
        engine._active_rooms = {
            room.id: ActiveRoom(room=room, target_temp=target, source="bank", **more)
        }

    started = await engine._bank(conn, band, now=BANKING)
    assert _targets(started) == [(74.0, "bank")]
    running()
    assert engine.bank_rooms == [room.id]
    assert engine.get_zone_status().bank_rooms == [room.id]
    temps["now"] = 74.3  # inside the deadband, and the peak has begun
    peak_now = BANKING + timedelta(hours=1, minutes=5)
    assert _targets(await engine._bank(conn, band, now=peak_now)) == [(74.0, "bank")]
    # No other room joins once the peak has begun.
    other = Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID)
    both = [
        *band,
        ActiveRoom(room=other, target_temp=68.0, source="house", heat_to=68.0, cool_to=76.0),
    ]
    assert _targets(await engine._bank(conn, both, now=peak_now)) == [
        (68.0, "house"),
        (74.0, "bank"),
    ]
    # Once the run has had its minimum runtime, banking is not carried on at
    # peak prices: the room is taken to be where it should be, part-way or
    # not, so the run ends by the usual rules rather than being cut off.
    engine._cycle_runtime_satisfied = lambda _tc, now=None: True
    temps["now"] = 74.9
    assert _targets(await engine._bank(conn, band, now=peak_now)) == [(74.9, "bank")]
    temps["now"] = None  # with no reading it keeps the target it had
    assert _targets(await engine._bank(conn, band, now=peak_now)) == [(74.0, "bank")]
    # A room whose vent has already closed is done: its target is left alone.
    temps["now"] = 74.9
    engine._room_cycle_states = {room.id: SimpleNamespace(vent_closed_at=peak_now)}
    assert _targets(await engine._bank(conn, band, now=peak_now)) == [(74.0, "bank")]
    engine._room_cycle_states = {room.id: SimpleNamespace(vent_closed_at=None)}
    assert _targets(await engine._bank(conn, band, now=peak_now)) == [(74.9, "bank")]
    engine._room_cycle_states = {}
    temps["now"] = 74.3
    engine._cycle_runtime_satisfied = lambda _tc, now=None: False
    # A hold takes the room over; a room no longer asked for anything leaves the run.
    hold = [ActiveRoom(room=room, target_temp=72.0, source="override")]
    assert await engine._bank(conn, hold, now=peak_now) == hold
    assert engine._bank_latch == {}
    # A run carried on (after a restart, say) keeps what was asked for rather
    # than what Eco had relaxed it to.
    running(75.0, requested_target=74.0)
    assert _targets(await engine._bank(conn, band, now=peak_now)) == [(74.0, "bank")]
    # While the zone runs the other way for someone else, nothing is asked.
    engine._cycle_mode = "heating"
    engine._active_rooms = {other.id: ActiveRoom(room=other, target_temp=80.0, source="override")}
    temps["now"] = 75.5
    assert await engine._bank(conn, band, now=BANKING) == band
    engine._cycle_mode = "cooling"
    assert _targets(await engine._bank(conn, band, now=BANKING)) == [(74.0, "bank")]
    temps["now"] = 74.3
    # A room asked while the zone ran for someone else never joined, and is not kept.
    engine._active_rooms = {other.id: ActiveRoom(room=other, target_temp=70.0, source="override")}
    assert await engine._bank(conn, band, now=peak_now) == band
    # Once the run is over nothing more is asked during the peak.
    running()
    engine._state = CycleState.IDLE
    assert await engine._bank(conn, band, now=peak_now) == band
    assert engine._bank_latch == {} and engine.bank_rooms == []
    assert await engine._bank(conn, band) == band  # and by the real clock, months later
    await conn.close()


async def test_through_the_engine_a_banked_room_starts_a_cooling_cycle(monkeypatch):
    from backend.engine import cycle_engine

    conn, engine, room, band, _temps = await _setup(monkeypatch)
    monkeypatch.setattr(cycle_engine, "get_active_rooms", AsyncMock(return_value=band))
    engine._reset_setpoint_to_ambient = AsyncMock()
    engine._monitor_rooms = AsyncMock()
    started = AsyncMock()
    engine._start_or_update_cycle = started
    real = engine._bank
    engine._bank = lambda c, a, _now: real(c, a, now=BANKING)
    await engine._do_tick(conn)
    active, mode = started.await_args.args[1], started.await_args.args[2]
    assert mode == "cooling" and _targets(active.values()) == [(74.0, "bank")]
    await conn.close()
