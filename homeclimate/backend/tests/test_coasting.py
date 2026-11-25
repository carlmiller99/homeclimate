"""Coasting: the limits, the prediction, and the record of misses."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import aiosqlite
import pytest

from backend import coasting, db, learning
from backend import room_model as rm

NOW = datetime(2026, 4, 6, 8, 0, tzinfo=UTC)


def _model(*, loss=0.1, drift=0.0, pull=0.0, fitted=NOW, spread=8.0, windows=600) -> rm.RoomModel:
    return rm.RoomModel("r", fitted, windows, loss, pull, 3.0, -3.0, drift, 10.0, 10.0, spread, 0.2)


def test_how_long_a_call_may_wait():
    assert coasting.wait_limit_min("heating", False) == 45
    assert coasting.wait_limit_min("heating", True) == 135  # strip heat: three times as long
    assert coasting.wait_limit_min("cooling", True) == 45


def test_the_outside_temperature_follows_the_forecast_from_the_sensor():
    hours = [(NOW + timedelta(hours=h), t) for h, t in ((2, 70.0), (0, 60.0), (1, 64.0))]
    # The sensor reads 2 °F under the forecast now: the whole curve is shifted.
    outlook = coasting.Outlook(NOW, 58.0, hours)
    assert outlook.at(0) == 58.0
    assert outlook.at(30) == 60.0
    assert outlook.at(90) == 65.0
    assert outlook.at(600) == 68.0  # past the end: the last hour
    # Before the first forecast hour, the first one stands.
    late = coasting.Outlook(NOW - timedelta(hours=1), 60.0, hours)
    assert late.at(0) == 60.0 and late.at(30) == 60.0
    # No forecast: the reading holds.
    assert coasting.Outlook(NOW, 58.0).at(120) == 58.0
    # Two entries for the same hour do not divide by zero.
    twice = coasting.Outlook(
        NOW, 60.0, [(NOW, 60.0), (NOW, 60.0), (NOW + timedelta(hours=1), 66.0)]
    )
    assert twice.at(30) == 63.0


def test_a_room_that_will_drift_there_is_given_the_minutes_it_needs():
    model = _model()  # 0.1 °F an hour for each degree warmer outside
    # 68.5 → 69 °F with 80 °F outside: about 1.1 °F an hour, so half an hour.
    outlook = coasting.Outlook(NOW, 80.0)
    assert coasting.minutes_alone(model, temp=68.5, goal=69.0, outlook=outlook, within_min=45) == 30
    # Not within the time allowed.
    assert (
        coasting.minutes_alone(model, temp=68.5, goal=69.0, outlook=outlook, within_min=20) is None
    )
    # Colder outside than in: it is drifting away, and waiting gains nothing.
    cold = coasting.Outlook(NOW, 40.0)
    assert coasting.minutes_alone(model, temp=68.5, goal=69.0, outlook=cold, within_min=135) is None
    # Already there.
    assert coasting.minutes_alone(model, temp=69.0, goal=69.0, outlook=cold, within_min=45) == 0
    # Cooling: 75.5 → 75 °F with 60 °F outside.
    cool = coasting.Outlook(NOW, 60.0)
    assert coasting.minutes_alone(model, temp=75.5, goal=75.0, outlook=cool, within_min=45) == 20
    assert (
        coasting.minutes_alone(model, temp=75.5, goal=75.0, outlook=outlook, within_min=45) is None
    )
    # A warming morning in the forecast gets a strip-heat room there; a flat reading would not.
    morning = coasting.Outlook(
        NOW, 66.0, [(NOW, 66.0), (NOW + timedelta(hours=1), 76.0), (NOW + timedelta(hours=2), 84.0)]
    )
    flat = coasting.Outlook(NOW, 66.0)
    assert coasting.minutes_alone(model, temp=68.0, goal=69.0, outlook=flat, within_min=135) is None
    found = coasting.minutes_alone(model, temp=68.0, goal=69.0, outlook=morning, within_min=135)
    assert found is not None and 60 < found <= 135
    # The thermostat's own reading pulls the room when the model has learned that.
    pulled = _model(loss=0.0, pull=0.5)
    assert (
        coasting.minutes_alone(pulled, temp=68.5, goal=69.0, outlook=cold, within_min=45, zone=72.0)
        == 20
    )


def test_only_a_fresh_model_that_has_learned_its_loss_is_trusted():
    assert coasting.usable(_model(), NOW)
    assert not coasting.usable(None, NOW)
    assert not coasting.usable(_model(fitted=None), NOW)
    assert not coasting.usable(_model(fitted=NOW - timedelta(days=8)), NOW)
    assert not coasting.usable(_model(spread=1.0), NOW)  # outside never differed enough to tell
    assert not coasting.usable(_model(windows=10), NOW)


@pytest.mark.asyncio
async def test_three_misses_in_a_week_send_it_back_to_watch_only():
    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row
    await db.init_db(conn)
    await learning.update_settings(conn, {"coast_level": 2})
    assert await coasting.misses(conn, now=NOW) == 0
    assert not await coasting.record_miss(
        conn, now=NOW - timedelta(days=9)
    )  # too long ago to count
    assert not await coasting.record_miss(conn, now=NOW - timedelta(days=2))
    assert not await coasting.record_miss(conn, now=NOW - timedelta(days=1))
    assert await coasting.misses(conn, now=NOW) == 2
    assert (await learning.get_settings(conn))["coast_level"] == 2
    assert await coasting.record_miss(conn, now=NOW)
    assert (await learning.get_settings(conn))["coast_level"] == 1
    # The count starts again, so switching it back On is a fresh start.
    assert await coasting.misses(conn, now=NOW) == 0
    # It says that it did so, for as long as it is still there (and for a week).
    when = await coasting.demoted_at(conn, now=NOW)
    assert when == NOW
    assert coasting.describe(1, 0, when) == {
        "level": 1,
        "misses_this_week": 0,
        "misses_to_watch_only": 3,
        "switched_back_at": NOW.isoformat(),
    }
    assert coasting.describe(2, 0, when)["switched_back_at"] is None
    assert coasting.describe(1, 0)["switched_back_at"] is None
    assert await coasting.demoted_at(conn, now=NOW + timedelta(days=8)) is None
    await db.set_system_setting(conn, coasting.DEMOTED_KEY, "soon")
    assert await coasting.demoted_at(conn, now=NOW) is None
    # A damaged record reads as none.
    for bad in ("not json", '{"a": 1}', '["x", 5]'):
        await db.set_system_setting(conn, coasting.MISSES_KEY, bad)
        assert await coasting.misses(conn, now=NOW) == 0
    await conn.close()
