"""Starting rooms early from what their model has learned."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from backend import db, house, learning, tz
from backend import room_model as rm

from .test_cycle_engine import _make_engine, _make_ha
from .test_heat_pump import _conn, _scheduled_room

pytestmark = pytest.mark.asyncio

NOW = datetime(2026, 1, 5, 5, 30, tzinfo=UTC)  # the block starts at 07:00


def _model(room_id: str, *, heat_hours=10.0, cool_hours=10.0, heat=3.0) -> rm.RoomModel:
    return rm.RoomModel(
        room_id, NOW, 600, 0.03, 0.0, heat, -3.0, 0.0, heat_hours, cool_hours, 8.0, 0.2
    )


START = datetime(2026, 1, 5, 7, 0, tzinfo=UTC)


async def _setup(
    monkeypatch, *, target=70.0, temp=64.0, level=2, model=None, outside=30.0, state="heat"
):
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)
    conn = await _conn()
    room = await _scheduled_room(conn, 7, target)
    await learning.update_settings(conn, {"early_start_level": level})
    found = model or _model(room.id)
    await conn.execute(
        "INSERT INTO room_models(room_id, fitted_at, windows, loss, pull, heat, cool, drift,"
        " heat_hours, cool_hours, out_spread, rmse) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            room.id,
            int(NOW.timestamp()),
            found.windows,
            found.loss,
            found.pull,
            found.heat,
            found.cool,
            found.drift,
            found.heat_hours,
            found.cool_hours,
            found.out_spread,
            found.rmse,
        ),
    )
    await conn.commit()
    engine = _make_engine(_make_ha(ambient=temp, hvac_mode=state, hvac_action="idle"))
    engine._logger = AsyncMock()
    engine._get_avg_temp = lambda _room, **_k: temp
    engine._read_outside_temp = AsyncMock(return_value=outside)
    return conn, engine, room


def _said(engine) -> list[str]:
    return [c.args[2] for c in engine._logger.log.await_args_list]


async def test_a_room_is_started_when_its_model_says_it_is_time(monkeypatch):
    # 66 → 70 °F at about 2 °F an hour net (3 heating, less 1 lost to 30 °F outside).
    conn, engine, room = await _setup(monkeypatch, temp=66.0)
    lead = _model(room.id).minutes_to(66.0, 70.0, 30.0, "heating", limit_min=180, zone=66.0)
    assert lead is not None and 100 <= lead <= 150
    # Too early: nothing yet.
    early = datetime(2026, 1, 5, 3, 0, tzinfo=UTC)
    assert await engine._early_starts(conn, [], now=early) == []
    just = datetime(2026, 1, 5, 7, 0, tzinfo=UTC) - timedelta(minutes=lead - 5)
    active = await engine._early_starts(conn, [], now=just)
    assert [(ar.room.id, ar.target_temp, ar.source) for ar in active] == [
        (room.id, 70.0, "schedule")
    ]
    # Said once, and again for the same block a week later.
    await engine._early_starts(conn, [], now=just)
    assert len(_said(engine)) == 1
    engine._early_latch = {}
    await engine._early_starts(conn, [], now=just + timedelta(days=7))
    assert len(_said(engine)) == 2
    assert len(engine._early_starts_logged) == 1  # last week's is forgotten
    assert _said(engine)[:1] == [
        f"Starting heating Bunk Room {lead} min early for Mon 7:00 AM (70°F),"
        " from what the room has taught"
    ]
    await conn.close()


async def test_watching_only_says_what_it_would_do_and_starts_nothing(monkeypatch):
    conn, engine, _room = await _setup(monkeypatch, level=1)
    assert await engine._early_starts(conn, [], now=NOW) == []
    assert _said(engine)[0].startswith("Would start (watching only) heating Bunk Room")
    await conn.close()


async def test_off_or_with_nothing_to_go_on_it_does_nothing(monkeypatch):
    conn, engine, room = await _setup(monkeypatch, level=0)
    assert await engine._early_starts(conn, [], now=NOW) == []
    await learning.update_settings(conn, {"early_start_level": 2})
    # No outside temperature: the model cannot say.
    engine._read_outside_temp = AsyncMock(return_value=None)
    assert await engine._early_starts(conn, [], now=NOW) == []
    engine._read_outside_temp = AsyncMock(return_value=30.0)
    # No reading from the room.
    engine._get_avg_temp = lambda _room, **_k: None
    assert await engine._early_starts(conn, [], now=NOW) == []
    # Already close enough to the target.
    engine._get_avg_temp = lambda _room, **_k: 69.8
    assert await engine._early_starts(conn, [], now=NOW) == []
    engine._get_avg_temp = lambda _room, **_k: 64.0
    # Already following something of its own.
    from backend.engine.room_manager import ActiveRoom

    held = [ActiveRoom(room=room, target_temp=66.0, source="override")]
    assert await engine._early_starts(conn, held, now=NOW) == held
    # Not in use, or not following its schedules.
    await house.set_switches(conn, room.id, {"in_use": False})
    assert await engine._early_starts(conn, [], now=NOW) == []
    await house.set_switches(conn, room.id, {"in_use": True, "use_schedules": False})
    assert await engine._early_starts(conn, [], now=NOW) == []
    await house.set_switches(conn, room.id, {"use_schedules": True})
    # A model that has not been refitted for over a week is not trusted.
    await conn.execute("UPDATE room_models SET fitted_at = ?", (int(NOW.timestamp()) - 8 * 86400,))
    await conn.commit()
    assert await engine._early_starts(conn, [], now=NOW) == []
    await conn.execute("UPDATE room_models SET fitted_at = NULL")
    await conn.commit()
    assert await engine._early_starts(conn, [], now=NOW) == []
    # No model for the room, or no models at all.
    await conn.execute("UPDATE room_models SET room_id = 'someone-else'")
    await conn.commit()
    assert await engine._early_starts(conn, [], now=NOW) == []
    await conn.execute("DELETE FROM room_models")
    await conn.commit()
    assert await engine._early_starts(conn, [], now=NOW) == []
    assert _said(engine) == []
    await conn.close()


async def test_only_a_rate_the_room_has_taught_is_used(monkeypatch):
    conn, engine, _room = await _setup(
        monkeypatch,
        model=_model("x", heat_hours=1.0),  # too little sustained heating
    )
    await conn.execute("UPDATE room_models SET heat_hours = 1.0")
    await conn.commit()
    assert await engine._early_starts(conn, [], now=NOW) == []
    await conn.close()


async def test_a_room_the_model_says_will_be_slow_gets_the_full_three_hours(monkeypatch):
    # Heating barely outruns the loss: it would not arrive within three hours.
    conn, engine, room = await _setup(monkeypatch, outside=-20.0)
    await conn.execute("UPDATE room_models SET heat = 2.6")
    await conn.commit()
    start = datetime(2026, 1, 5, 7, 0, tzinfo=UTC)
    assert await engine._early_starts(conn, [], now=start - timedelta(minutes=181)) == []
    active = await engine._early_starts(conn, [], now=start - timedelta(minutes=179))
    assert [ar.room.id for ar in active] == [room.id]
    assert "180 min early" in _said(engine)[0]
    await conn.close()


async def test_a_short_warm_up_still_starts_a_quarter_of_an_hour_early(monkeypatch):
    conn, engine, room = await _setup(monkeypatch, temp=69.0)
    start = datetime(2026, 1, 5, 7, 0, tzinfo=UTC)
    # Under 30 minutes of heating at this rate; but not before 15 minutes out…
    lead = max(15, _model(room.id).minutes_to(69.0, 70.0, 30.0, "heating", zone=69.0) or 0)
    assert await engine._early_starts(conn, [], now=start - timedelta(minutes=lead + 2)) == []
    assert await engine._early_starts(conn, [], now=start - timedelta(minutes=lead - 1)) != []
    await conn.close()


async def test_cooling_starts_early_too_but_never_toward_a_bands_heat_to(monkeypatch):
    conn, engine, room = await _setup(
        monkeypatch, target=72.0, temp=78.0, outside=95.0, state="cool"
    )
    active = await engine._early_starts(conn, [], now=NOW)
    assert [ar.target_temp for ar in active] == [72.0]
    assert _said(engine)[0].startswith("Starting cooling Bunk Room")
    # The coming block is a band from 72 °F: its target here is the heat-to.
    (block,) = await db.get_schedules_for_room(conn, room.id)
    await house.set_target_band(conn, "schedule", block.id, 72.0, 78.0)
    engine._early_latch = {}
    assert await engine._early_starts(conn, [], now=NOW) == []
    await conn.close()


async def test_never_against_the_side_the_building_is_on(monkeypatch):
    conn, engine, _room = await _setup(monkeypatch)
    for side in ("cooling", "hold", "off"):
        engine._get_building_side = lambda side=side: (side, True)
        assert await engine._early_starts(conn, [], now=NOW) == []
    # A room already started is let go when the building turns the other way.
    engine._get_building_side = lambda: ("heating", True)
    assert await engine._early_starts(conn, [], now=NOW) != []
    engine._get_building_side = lambda: ("cooling", True)
    assert await engine._early_starts(conn, [], now=NOW) == []
    assert engine._early_latch == {}
    # A side that is only watched, or the same side, holds nothing back.
    engine._get_building_side = lambda: ("cooling", False)
    assert await engine._early_starts(conn, [], now=NOW) != []
    engine._get_building_side = lambda: ("heating", True)
    assert await engine._early_starts(conn, [], now=NOW) != []
    await conn.close()


async def test_once_started_a_room_is_kept_until_its_block_begins(monkeypatch):
    """Warming faster than the model expected must not drop the room out and back in."""
    conn, engine, room = await _setup(monkeypatch, temp=66.0)
    lead = _model(room.id).minutes_to(66.0, 70.0, 30.0, "heating", limit_min=180, zone=66.0)
    began = START - timedelta(minutes=lead - 1)
    assert await engine._early_starts(conn, [], now=began) != []
    # Ten minutes on it is at 69 °F: on its own that would be "too early" again.
    engine._get_avg_temp = lambda _room, **_k: 69.0
    later = began + timedelta(minutes=10)
    assert [ar.target_temp for ar in await engine._early_starts(conn, [], now=later)] == [70.0]
    # Inside the deadband, and even past the target, it is still the room's target:
    # the cycle's own rules end the run, as they would for the block itself.
    engine._get_avg_temp = lambda _room, **_k: 70.4
    assert await engine._early_starts(conn, [], now=later + timedelta(minutes=5)) != []
    assert len(_said(engine)) == 1
    # A fresh engine at that moment would not start it.
    engine._early_latch = {}
    assert await engine._early_starts(conn, [], now=later + timedelta(minutes=5)) == []
    # A hold takes the room over and the early start is forgotten.
    engine._get_avg_temp = lambda _room, **_k: 66.0
    assert await engine._early_starts(conn, [], now=later) != []
    from backend.engine.room_manager import ActiveRoom

    held = [ActiveRoom(room=room, target_temp=66.0, source="override")]
    assert await engine._early_starts(conn, held, now=later) == held
    assert engine._early_latch == {}
    # The block's target changes: judged afresh against the new one.
    assert await engine._early_starts(conn, [], now=later) != []
    await conn.execute("UPDATE schedules SET target_temp = 66.0")
    await conn.commit()
    assert await engine._early_starts(conn, [], now=later) == []
    # Switched off, everything is let go.
    await conn.execute("UPDATE schedules SET target_temp = 70.0")
    await conn.commit()
    assert await engine._early_starts(conn, [], now=later) != []
    await learning.update_settings(conn, {"early_start_level": 0})
    await engine._early_starts(conn, [], now=later)
    assert engine._early_latch == {}
    await conn.close()


async def test_the_weather_and_the_thermostat_have_to_agree(monkeypatch):
    # Winter: the room is at 70 °F and the next block is a setback to 64 °F.
    # Cooling early toward it would run the air conditioning for nothing.
    conn, engine, _room = await _setup(monkeypatch, target=64.0, temp=70.0, outside=35.0)
    assert await engine._early_starts(conn, [], now=NOW) == []
    # Warm outside, but the thermostat is set to heat only.
    engine._read_outside_temp = AsyncMock(return_value=80.0)
    assert await engine._early_starts(conn, [], now=NOW) == []
    assert _said(engine) == []
    await conn.close()
    # Summer: at 72 °F with a setback up to 78 °F coming, and 90 °F outside.
    conn, engine, _room = await _setup(
        monkeypatch, target=78.0, temp=72.0, outside=90.0, state="cool"
    )
    assert await engine._early_starts(conn, [], now=NOW) == []
    engine._read_outside_temp = AsyncMock(return_value=40.0)
    assert await engine._early_starts(conn, [], now=NOW) == []  # set to cool only
    await conn.close()
    # A heat pump expecting its strips: the model never learned from those.
    conn, engine, _room = await _setup(monkeypatch)
    engine._hp_strips = True
    assert await engine._early_starts(conn, [], now=NOW) == []
    engine._hp_strips = False
    assert await engine._early_starts(conn, [], now=NOW) != []
    await conn.close()


async def test_a_room_in_a_block_is_started_early_only_for_more_of_the_same(monkeypatch):
    """Night setback to 62 °F, then 70 °F at 07:00: the usual case."""
    from backend.engine.room_manager import ActiveRoom

    conn, engine, room = await _setup(monkeypatch, temp=62.0)

    def night(target, **more):
        return [ActiveRoom(room=room, target_temp=target, source="schedule", **more)]

    active = await engine._early_starts(conn, night(62.0), now=NOW)
    assert [(ar.target_temp, ar.source) for ar in active] == [(70.0, "schedule")]
    # The block it is in already asks for as much or more: nothing to do early.
    engine._early_latch = {}
    assert await engine._early_starts(conn, night(72.0), now=NOW) == night(72.0)
    # A banded block, or presence, is left alone.
    banded = night(62.0, heat_to=62.0, cool_to=76.0)
    assert await engine._early_starts(conn, banded, now=NOW) == banded
    here = [ActiveRoom(room=room, target_temp=62.0, source="presence")]
    assert await engine._early_starts(conn, here, now=NOW) == here
    await conn.close()
    # Cooling: 76 °F now, 72 °F next, hot outside.
    conn, engine, room = await _setup(
        monkeypatch, target=72.0, temp=76.0, outside=95.0, state="cool"
    )
    now = START - timedelta(minutes=20)
    active = await engine._early_starts(conn, night(76.0), now=now)
    assert [ar.target_temp for ar in active] == [72.0]
    engine._early_latch = {}
    assert await engine._early_starts(conn, night(70.0), now=now) == night(70.0)
    await conn.close()


async def test_the_coming_blocks_own_deadband_and_the_rooms_offset_are_used(monkeypatch):
    conn, engine, room = await _setup(monkeypatch, temp=68.0)
    just = START - timedelta(minutes=20)
    # 2 °F short, but the block has a 3 °F deadband: it would not start this itself.
    await conn.execute("UPDATE schedules SET deadband_override = 3.0")
    await conn.commit()
    assert await engine._early_starts(conn, [], now=just) == []
    await conn.execute("UPDATE schedules SET deadband_override = 1.0")
    await conn.commit()
    (early,) = await engine._early_starts(conn, [], now=just)
    assert early.deadband_override == 1.0  # carried, so nothing changes at the hand-over
    # The model is asked in raw readings: a +2 °F offset makes this room read 70 °F.
    engine._early_latch = {}
    room.temp_offset = 2.0
    await db.upsert_room(conn, room)
    assert await engine._early_starts(conn, [], now=just) == []
    await conn.close()


async def test_a_block_that_expires_before_it_next_starts_is_not_prepared_for(monkeypatch):
    conn, engine, _room = await _setup(monkeypatch)
    assert await engine._early_starts(conn, [], now=NOW) != []
    engine._early_latch = {}
    await conn.execute("UPDATE schedules SET expires_at = '2026-01-05T06:00:00'")
    await conn.commit()
    assert await engine._early_starts(conn, [], now=NOW) == []
    await conn.close()


async def test_without_a_logger_it_still_works(monkeypatch):
    conn, engine, _room = await _setup(monkeypatch)
    engine._logger = None
    assert await engine._early_starts(conn, [], now=NOW) != []
    await conn.close()


async def test_through_the_engine_a_fast_room_is_asked_for_on_every_tick(monkeypatch):
    """The whole tick, a minute at a time, with the room warming faster than its model."""
    from backend.engine import cycle_engine

    conn, engine, room = await _setup(monkeypatch, temp=64.0)
    monkeypatch.setattr(cycle_engine, "get_active_rooms", AsyncMock(return_value=[]))
    engine._reset_setpoint_to_ambient = AsyncMock()
    engine._monitor_rooms = AsyncMock()
    started = AsyncMock()
    engine._start_or_update_cycle = started
    clock = [START - timedelta(hours=4)]
    temp = [64.0]
    engine._get_avg_temp = lambda _room, **_k: temp[0]
    real = engine._early_starts
    engine._early_starts = lambda c, active: real(c, active, now=clock[0])
    asked: list[bool] = []
    while clock[0] < START and temp[0] < 69.4:
        started.reset_mock()
        await engine._do_tick(conn)
        on = started.await_args is not None
        if on:
            active, mode = started.await_args.args[1], started.await_args.args[2]
            assert (mode, {rid: ar.target_temp for rid, ar in active.items()}) == (
                "heating",
                {room.id: 70.0},
            )
            temp[0] += 4.5 / 60  # half as fast again as the model's 3 °F an hour
        asked.append(on)
        clock[0] += timedelta(minutes=1)
    # Once it has begun it is asked for on every tick: no dropping out and back.
    first = asked.index(True)
    assert first >= 60 and all(asked[first:]) and temp[0] >= 69.4
    assert len(_said(engine)) == 1
    await conn.close()


async def test_through_the_engine_a_winter_setback_starts_nothing_early(monkeypatch):
    from backend.engine import cycle_engine

    conn, engine, _room = await _setup(monkeypatch, target=64.0, temp=70.0, outside=35.0)
    monkeypatch.setattr(cycle_engine, "get_active_rooms", AsyncMock(return_value=[]))
    engine._reset_setpoint_to_ambient = AsyncMock()
    engine._monitor_rooms = AsyncMock()
    engine._start_or_update_cycle = AsyncMock()
    real = engine._early_starts
    for minutes in (170, 90, 30, 5):
        engine._early_starts = lambda c, active, m=minutes: real(
            c, active, now=START - timedelta(minutes=m)
        )
        await engine._do_tick(conn)
    engine._start_or_update_cycle.assert_not_awaited()
    await conn.close()


async def test_the_setting_is_one_of_three_levels(monkeypatch):
    conn = await _conn()
    assert (await learning.get_settings(conn))["early_start_level"] == 0
    for bad in (3, -1, True, "on"):
        with pytest.raises(learning.LearningError):
            await learning.update_settings(conn, {"early_start_level": bad})
    await conn.close()
