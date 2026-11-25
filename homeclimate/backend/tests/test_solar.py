"""The sun: where it is, how strong, how much lands on a window, and where the house is."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from backend import db, shades, solar
from backend.models import Room

from .test_heat_pump import THERMO_ID, _conn

LAT, LON = 32.0, -95.0  # a house at 32° N, 95° W: solar noon is about 18:20 UTC


def test_the_suns_position_through_a_summer_day():
    noon = solar.position(LAT, LON, datetime(2026, 6, 21, 18, 22, tzinfo=UTC))
    assert noon[0] == pytest.approx(81.4, abs=0.5)  # 90 - 32 + 23.4
    assert noon[1] == pytest.approx(180.0, abs=3.0)
    morning = solar.position(LAT, LON, datetime(2026, 6, 21, 14, 0, tzinfo=UTC))
    evening = solar.position(LAT, LON, datetime(2026, 6, 21, 23, 0, tzinfo=UTC))
    assert 20 < morning[0] < 40 and 60 < morning[1] < 100  # in the east
    assert 20 < evening[0] < 40 and 260 < evening[1] < 300  # in the west
    night = solar.position(LAT, LON, datetime(2026, 6, 21, 6, 0, tzinfo=UTC))
    assert night[0] < -20
    # Midwinter noon is far lower, and still due south.
    winter = solar.position(LAT, LON, datetime(2026, 12, 21, 18, 18, tzinfo=UTC))
    assert winter[0] == pytest.approx(34.6, abs=0.5) and winter[1] == pytest.approx(180, abs=3)
    # South of the tropics the noon sun is in the north.
    south = solar.position(-35.0, LON, datetime(2026, 6, 21, 18, 22, tzinfo=UTC))
    assert south[0] == pytest.approx(31.6, abs=0.5)
    assert min(south[1], 360 - south[1]) < 5
    # Any zone's clock gives the same answer for the same instant.
    from zoneinfo import ZoneInfo

    local = datetime(2026, 6, 21, 13, 22, tzinfo=ZoneInfo("America/Chicago"))
    assert solar.position(LAT, LON, local) == noon
    # Straight overhead, and at a pole, there is no direction to speak of.
    assert solar.position(90.0, 0.0, datetime(2026, 6, 21, 12, 0, tzinfo=UTC))[1] == 180.0


def test_strength_and_what_lands_on_a_window():
    assert solar.clear_sky(0.0) == 0.0 and solar.clear_sky(-5.0) == 0.0
    assert solar.clear_sky(81.0) == pytest.approx(0.94, abs=0.05)  # kW/m² near midsummer noon
    assert 0.0 < solar.clear_sky(10.0) < 0.15 < solar.clear_sky(30.0) < solar.clear_sky(60.0)
    # A low sun square on to the glass; nothing from behind, at night, or from overhead.
    assert solar.on_window(180.0, 20.0, 180.0) == pytest.approx(0.94, abs=0.01)
    assert solar.on_window(180.0, 20.0, 135.0) == pytest.approx(0.66, abs=0.01)
    assert solar.on_window(180.0, 20.0, 0.0) == 0.0
    assert solar.on_window(180.0, -1.0, 180.0) == 0.0
    assert solar.on_window(180.0, 90.0, 180.0) == pytest.approx(0.0, abs=1e-9)


def test_the_sun_on_a_rooms_windows():
    morning = datetime(2026, 6, 21, 14, 0, tzinfo=UTC)
    east = solar.gain(LAT, LON, morning, [90.0])
    west = solar.gain(LAT, LON, morning, [270.0])
    assert east > 0.3 and west == 0.0
    # Two walls of glass are averaged, not added.
    assert solar.gain(LAT, LON, morning, [90.0, 270.0]) == pytest.approx(east / 2)
    assert solar.gain(LAT, LON, morning, []) == 0.0
    assert solar.gain(LAT, LON, datetime(2026, 6, 21, 6, 0, tzinfo=UTC), [90.0]) == 0.0


@pytest.mark.asyncio
async def test_the_houses_location_is_remembered_from_home_assistant():
    conn = await _conn()
    ha = MagicMock()
    assert await solar.location(conn) is None and await solar.for_rooms(conn) == {}
    # Nothing usable is not remembered, and does not wipe what is.
    for attrs in (
        None,
        {},
        {"latitude": "north", "longitude": 5},
        {"latitude": 95, "longitude": 5},
    ):
        ha.get_state.return_value = None if attrs is None else {"attributes": attrs}
        await solar.remember_location(conn, ha)
        assert await solar.location(conn) is None
    ha.get_state.return_value = {"attributes": {"latitude": LAT, "longitude": LON}}
    await solar.remember_location(conn, ha)
    ha.get_state.assert_called_with("zone.home")
    ha.get_state.return_value = {"attributes": {"latitude": float("nan"), "longitude": LON}}
    await solar.remember_location(conn, ha)
    assert await solar.location(conn) == (LAT, LON)
    # A room's windows are its shades, automated or not.
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    bare = Room.create(name="Hall", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    await db.upsert_room(conn, bare)
    assert await solar.for_rooms(conn) == {}
    await shades.save_shade(conn, "cover.bunk_east", {"room_id": room.id, "facing": "E"})
    await shades.save_shade(
        conn, "cover.bunk_west", {"room_id": room.id, "facing": "W", "never_control": True}
    )
    suns = await solar.for_rooms(conn)
    assert set(suns) == {room.id}
    morning = datetime(2026, 6, 21, 14, 0, tzinfo=UTC)
    assert suns[room.id](morning) == solar.gain(LAT, LON, morning, [90.0, 270.0])
    await conn.close()
