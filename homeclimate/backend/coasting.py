"""Coasting: letting a call wait when the room will get there on its own.

A room a little short of its target is not always worth starting the equipment
for. If its model (``room_model``) and the forecast say it will drift to its
target by itself soon, the call waits. This is the pure part: the limits, the
prediction, and the record of misses that sends the feature back to Watch
Only. The engine (``CycleEngine._coast``) decides which rooms it applies to.

The bounds, all fixed:

* a room 2 °F or more from its target is never kept waiting;
* a wait lasts at most 45 minutes, or three times that where heating is
  costly (electric strip heat), since a start avoided there saves the most;
* a wait that ends with the room 1.5 °F or more from its target is a miss, and
  three misses in a week switch the feature back to Watch Only.

All temperatures are °F.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import db, learning, room_model

LEVELS = ("off", "watch", "on")

MAX_GAP_F = 2.0  # a room this far from its target is never kept waiting
BASE_WAIT_MIN = 45  # the longest wait
COSTLY_FACTOR = 3  # ... times this where heating is strip heat
MISS_F = 1.5  # a wait that ends this far from the target was a mistake
MISSES_TO_DEMOTE = 3
MISS_WINDOW = timedelta(days=7)
STALE_DAYS = room_model.EARLY_START_STALE_DAYS

COOL_OFF = timedelta(minutes=30)  # after a wait, before the same room may wait again
STALE_AFTER = timedelta(minutes=5)  # a wait not looked at for this long is dropped

MISSES_KEY = "learn_coast_misses"
DEMOTED_KEY = learning.COAST_DEMOTED_KEY


def wait_limit_min(mode: str, costly_heat: bool) -> int:
    """How long a call may wait at most."""
    return BASE_WAIT_MIN * (COSTLY_FACTOR if mode == "heating" and costly_heat else 1)


@dataclass(frozen=True)
class Outlook:
    """The outside temperature now and over the coming hours."""

    now: datetime
    outside: float
    ahead: Sequence[tuple[datetime, float]] = ()  # forecast hours, any order
    # The sun on this room's windows at a time (``solar.for_rooms``), if known.
    sun: Callable[[datetime], float] | None = None

    def sun_at(self, minutes: float) -> float:
        """The sun on the room's windows ``minutes`` from now; 0 when not known."""
        return 0.0 if self.sun is None else self.sun(self.now + timedelta(minutes=minutes))

    def at(self, minutes: float) -> float:
        """The outside temperature expected ``minutes`` from now.

        Read from the forecast between its hours, shifted so that it agrees
        with the sensor now. With no forecast the reading is taken to hold.
        """
        when = self.now + timedelta(minutes=minutes)
        points = sorted(self.ahead)
        if not points:
            return self.outside
        shift = self.outside - _between(points, self.now)
        return _between(points, when) + shift


def _between(points: Sequence[tuple[datetime, float]], when: datetime) -> float:
    """The forecast at ``when``: between two hours, or the nearest end."""
    if when <= points[0][0]:
        return points[0][1]
    for (t0, v0), (t1, v1) in zip(points, points[1:], strict=False):
        if when <= t1:
            span = (t1 - t0).total_seconds()
            return v0 if span <= 0 else v0 + (v1 - v0) * (when - t0).total_seconds() / span
    return points[-1][1]


def minutes_alone(
    model: room_model.RoomModel,
    *,
    temp: float,
    goal: float,
    outlook: Outlook,
    within_min: int,
    zone: float | None = None,
    floor: float | None = None,
) -> int | None:
    """Minutes for the room to drift from ``temp`` to ``goal`` with nothing running.

    None when the model says it will not get there within ``within_min``, or
    that it would first slip to ``floor`` (below it when warming, above it
    when cooling): a wait the model itself expects to end badly is not begun.
    Stepped five minutes at a time, with the outside temperature following the
    forecast and the sun on the room's windows following the clock.
    """
    rising = goal > temp
    if goal == temp:
        return 0
    now = temp
    step_min = learning.SAMPLE_EVERY_MIN
    for step in range(1, within_min // step_min + 1):
        # It may slip a little first and still arrive, on a morning that is warming up.
        ahead = (step - 1) * step_min
        now += model.rate(now, outlook.at(ahead), zone, sun=outlook.sun_at(ahead)) * step_min / 60
        if floor is not None and ((now <= floor) if rising else (now >= floor)):
            return None
        if (now >= goal) if rising else (now <= goal):
            return step * step_min
    return None


def usable(model: room_model.RoomModel | None, now: datetime) -> bool:
    """Whether a model may be trusted to say a room will drift: fresh, with its loss learned."""
    return (
        model is not None
        and model.fitted_at is not None
        and now - model.fitted_at <= timedelta(days=STALE_DAYS)
        and model.learned["loss"]
    )


def _decode(raw: str) -> list[int]:
    try:
        found = json.loads(raw)
    except ValueError:
        return []
    return [t for t in found if isinstance(t, int)] if isinstance(found, list) else []


async def misses(conn: aiosqlite.Connection, *, now: datetime) -> int:
    """How many waits ended badly in the last week."""
    since = int((now - MISS_WINDOW).timestamp())
    return sum(
        1 for t in _decode(await db.get_system_setting(conn, MISSES_KEY, "[]")) if t >= since
    )


async def record_miss(conn: aiosqlite.Connection, *, now: datetime) -> bool:
    """Note a wait that ended badly. True when that makes three in a week.

    On the third the feature is switched back to Watch Only and the count
    starts again, so switching it On later is a fresh start.
    """
    since = int((now - MISS_WINDOW).timestamp())
    kept = [t for t in _decode(await db.get_system_setting(conn, MISSES_KEY, "[]")) if t >= since]
    kept.append(int(now.timestamp()))
    demote = len(kept) >= MISSES_TO_DEMOTE
    await db.set_system_setting(conn, MISSES_KEY, "[]" if demote else json.dumps(kept))
    if demote:
        await learning.update_settings(conn, {"coast_level": LEVELS.index("watch")})
        await db.set_system_setting(conn, DEMOTED_KEY, str(int(now.timestamp())))
    return demote


async def demoted_at(conn: aiosqlite.Connection, *, now: datetime) -> datetime | None:
    """When it last switched itself back to Watch Only, if within the last week."""
    raw = await db.get_system_setting(conn, DEMOTED_KEY, "")
    if not raw.isdigit():
        return None
    when = datetime.fromtimestamp(int(raw), UTC)
    return when if now - when <= MISS_WINDOW else None


def describe(level: int, missed: int, demoted: datetime | None = None) -> dict[str, Any]:
    """What the Smart Learning section shows beside the setting."""
    return {
        "level": level,
        "misses_this_week": missed,
        "misses_to_watch_only": MISSES_TO_DEMOTE,
        # Only while it is still where it put itself.
        "switched_back_at": demoted.isoformat()
        if demoted is not None and level == LEVELS.index("watch")
        else None,
    }
