"""Eco Mode, Let an Empty Zone Drift Further: when it widens a room's targets, and by how much."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from backend import db, eco
from backend.engine.room_manager import ActiveRoom
from backend.models import Room, ThermostatConfig

from .test_cycle_engine import _make_engine, _make_ha
from .test_heat_pump import THERMO_ID, _conn

NOW = datetime(2026, 7, 6, 15, 0, tzinfo=UTC)


async def _setup(*, hours=2.0, eco_on=True, lo=60.0, hi=85.0, room_eco=None):
    conn = await _conn()
    tc = await db.get_thermostat_config(conn, THERMO_ID)
    tc = tc or ThermostatConfig(thermostat_entity_id=THERMO_ID)
    tc.name, tc.eco_mode_enabled, tc.eco_empty_zone_hours = "North Wing", eco_on, hours
    tc.min_setpoint, tc.max_setpoint = lo, hi
    await db.upsert_thermostat_config(conn, tc)
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    room.eco_mode_enabled = room_eco
    await db.upsert_room(conn, room)
    engine = _make_engine(_make_ha(ambient=72.0, hvac_mode="heat", hvac_action="idle"))
    engine._logger = AsyncMock()
    return conn, engine, room


def _house(room, heat_to=68.0, cool_to=76.0) -> ActiveRoom:
    return ActiveRoom(
        room=room, target_temp=heat_to, source="house", heat_to=heat_to, cool_to=cool_to
    )


def _said(engine) -> list[str]:
    return [c.args[2] for c in engine._logger.log.await_args_list]


async def _band_after(engine, conn, room, minutes, *, vacation=False, **band):
    ar = _house(room, **band)
    await engine._empty_zone_drift(conn, [ar], NOW + timedelta(minutes=minutes), vacation)
    return ar.heat_to, ar.cool_to


@pytest.mark.asyncio
async def test_an_empty_zone_widens_only_after_the_hours_have_passed():
    conn, engine, room = await _setup()
    # The first look counts the zone as just used: nothing is known before it.
    assert await _band_after(engine, conn, room, 0) == (68.0, 76.0)
    assert await _band_after(engine, conn, room, 119) == (68.0, 76.0)
    assert not engine.empty_drift and _said(engine) == []
    assert await _band_after(engine, conn, room, 120) == (66.0, 78.0)
    assert engine.empty_drift and engine.get_zone_status().empty_drift
    # Said once, not every minute.
    assert await _band_after(engine, conn, room, 121) == (66.0, 78.0)
    assert _said(engine) == [
        "Eco Mode: nothing has asked for North Wing for 2 hours, so its rooms may drift 2°F further"
    ]
    assert eco.EMPTY_ZONE_EXTRA_F == 2.0
    await conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["override", "schedule", "presence"])
async def test_anything_asking_for_a_room_puts_the_targets_back_at_once(source):
    conn, engine, room = await _setup()
    await _band_after(engine, conn, room, 0)
    assert await _band_after(engine, conn, room, 180) == (66.0, 78.0)
    other = Room.create(name="Den", thermostat_entity_id=THERMO_ID)
    asked = ActiveRoom(room=other, target_temp=70.0, source=source)
    following = _house(room)
    await engine._empty_zone_drift(conn, [asked, following], NOW + timedelta(minutes=181), False)
    assert (following.heat_to, following.cool_to) == (68.0, 76.0)
    assert not engine.empty_drift
    assert _said(engine)[-1] == "Eco Mode: North Wing is back to its targets"
    # The hours start over from the last time something asked.
    assert await _band_after(engine, conn, room, 181 + 119) == (68.0, 76.0)
    assert await _band_after(engine, conn, room, 181 + 120) == (66.0, 78.0)
    await conn.close()


@pytest.mark.asyncio
async def test_the_wider_targets_stop_at_the_safety_limits():
    conn, engine, room = await _setup(lo=67.0, hi=77.5)
    await _band_after(engine, conn, room, 0)
    assert await _band_after(engine, conn, room, 120) == (67.0, 77.5)
    # A target already past a limit is left as it is, not pulled back in.
    assert await _band_after(engine, conn, room, 121, heat_to=65.0, cool_to=80.0) == (65.0, 80.0)
    await conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, vacation, suspended",
    [
        ({"hours": 0.0}, False, False),  # the setting is off
        ({"eco_on": False}, False, False),  # Eco Mode is off for the zone
        ({"room_eco": False}, False, False),  # the room opted out of Eco Mode
        ({}, True, False),  # Vacation Mode has its own hold
        ({}, False, True),  # Eco Mode is suspended
    ],
)
async def test_nothing_widens_when_it_should_not(setup, vacation, suspended):
    conn, engine, room = await _setup(**setup)
    engine._get_eco_suspended = lambda: suspended
    await _band_after(engine, conn, room, 0, vacation=vacation)
    assert await _band_after(engine, conn, room, 600, vacation=vacation) == (68.0, 76.0)
    assert not engine.empty_drift and _said(engine) == []
    await conn.close()


@pytest.mark.asyncio
async def test_a_room_that_opted_in_widens_though_the_zone_has_eco_off_and_only_house_rooms():
    conn, engine, room = await _setup(eco_on=False, room_eco=True)
    await _band_after(engine, conn, room, 0)
    assert await _band_after(engine, conn, room, 120) == (66.0, 78.0)
    # A room with a single target (no band) and one added by another feature are left alone.
    single = ActiveRoom(room=room, target_temp=70.0, source="house")
    balance = ActiveRoom(room=room, target_temp=70.0, source="balance", heat_to=68.0, cool_to=76.0)
    await engine._empty_zone_drift(conn, [single, balance], NOW + timedelta(minutes=130), False)
    assert (balance.heat_to, balance.cool_to) == (68.0, 76.0) and single.heat_to is None
    assert not engine.empty_drift
    await conn.close()


@pytest.mark.asyncio
async def test_a_trip_counts_as_use_so_the_hours_start_when_it_ends():
    conn, engine, room = await _setup()
    await _band_after(engine, conn, room, 0)
    await _band_after(engine, conn, room, 500, vacation=True)
    assert await _band_after(engine, conn, room, 500 + 119) == (68.0, 76.0)
    assert await _band_after(engine, conn, room, 500 + 120) == (66.0, 78.0)
    await conn.close()


@pytest.mark.asyncio
async def test_no_logger_is_fine():
    conn, engine, room = await _setup()
    engine._logger = None
    await _band_after(engine, conn, room, 0)
    assert await _band_after(engine, conn, room, 120) == (66.0, 78.0)
    await conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("why", ["vacation", "disabled"])
async def test_a_tick_that_returns_early_still_counts_as_use(why):
    """A trip with safety cycles off, and the system switched off, never reach
    the room list: the zone must not look empty for all that time."""
    conn, engine, room = await _setup(hours=1.0)
    tc = await db.get_thermostat_config(conn, THERMO_ID)
    tc.vacation_safety_cycles = False
    await db.upsert_thermostat_config(conn, tc)
    await _band_after(engine, conn, room, 0)
    assert await _band_after(engine, conn, room, 60) == (66.0, 78.0)
    assert engine.empty_drift
    if why == "vacation":
        engine._get_vacation_mode = lambda: True
    else:
        engine._get_enabled = lambda: False
    await engine.tick(conn)
    assert not engine.empty_drift
    assert "Eco Mode: North Wing is back to its targets" in _said(engine)
    # The hours start over from that tick, not from before it.
    last = engine._zone_asked_at
    assert last is not None and last > NOW + timedelta(minutes=60)
    ar = _house(room)
    await engine._empty_zone_drift(conn, [ar], last + timedelta(minutes=59), False)
    assert (ar.heat_to, ar.cool_to) == (68.0, 76.0)
    await conn.close()


@pytest.mark.asyncio
async def test_one_hour_is_said_in_the_singular():
    conn, engine, room = await _setup(hours=1.0)
    await _band_after(engine, conn, room, 0)
    await _band_after(engine, conn, room, 60)
    assert "for 1 hour, so" in _said(engine)[0]
    await conn.close()
