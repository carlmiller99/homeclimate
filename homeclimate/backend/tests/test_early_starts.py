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


async def _setup(monkeypatch, *, target=70.0, temp=64.0, level=2, model=None, outside=30.0):
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
            1,
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
    engine = _make_engine(_make_ha(ambient=temp, hvac_mode="heat", hvac_action="idle"))
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
    await engine._early_starts(conn, [], now=just)
    assert _said(engine) == [
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
    conn, engine, room = await _setup(monkeypatch, target=72.0, temp=78.0, outside=95.0)
    active = await engine._early_starts(conn, [], now=NOW)
    assert [ar.target_temp for ar in active] == [72.0]
    assert _said(engine)[0].startswith("Starting cooling Bunk Room")
    # The coming block is a band from 72 °F: its target here is the heat-to.
    (block,) = await db.get_schedules_for_room(conn, room.id)
    await house.set_target_band(conn, "schedule", block.id, 72.0, 78.0)
    assert await engine._early_starts(conn, [], now=NOW) == []
    await conn.close()


async def test_never_against_the_side_the_building_is_on(monkeypatch):
    conn, engine, _room = await _setup(monkeypatch)
    for side in ("cooling", "hold", "off"):
        engine._get_building_side = lambda side=side: (side, True)
        assert await engine._early_starts(conn, [], now=NOW) == []
    # A side that is only watched, or the same side, holds nothing back.
    engine._get_building_side = lambda: ("cooling", False)
    assert await engine._early_starts(conn, [], now=NOW) != []
    engine._get_building_side = lambda: ("heating", True)
    assert await engine._early_starts(conn, [], now=NOW) != []
    await conn.close()


async def test_the_log_of_what_was_said_does_not_grow_for_ever(monkeypatch):
    conn, engine, _room = await _setup(monkeypatch)
    engine._early_starts_logged = {(str(i), "x", "on") for i in range(201)}
    await engine._early_starts(conn, [], now=NOW)
    assert len(engine._early_starts_logged) == 1
    engine._logger = None
    assert await engine._early_starts(conn, [], now=NOW) != []
    await conn.close()


async def test_the_setting_is_one_of_three_levels(monkeypatch):
    conn = await _conn()
    assert (await learning.get_settings(conn))["early_start_level"] == 0
    for bad in (3, -1, True, "on"):
        with pytest.raises(learning.LearningError):
            await learning.update_settings(conn, {"early_start_level": bad})
    await conn.close()
