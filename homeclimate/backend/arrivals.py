"""Get Rooms Ready for Usual Arrivals: start a room a little before it is usually used.

A room's usual hours are the hours of the week its occupancy sensors have
shown it in use, week after week (``suggestions.usual_hours``: two weeks of
history, the same rule the schedule suggestion uses). An *arrival* is the
first of a run of usual hours. Shortly before one, the room is brought to the
temperature it would be given the moment someone walked in, so it is already
comfortable when they do.

It is a guess, so it is treated as one: the room is asked for only when
nothing more specific is (no hold, schedule or occupancy), it gives way to any
room that calls for itself, and if nobody has arrived half an hour into the
hour it is let go. All times here are the house's wall clock.
"""

from __future__ import annotations

from datetime import datetime, timedelta

LEVELS = ("off", "watch", "on")

LEAD_MIN = 30  # how long before the hour, until the room has taught its own time
MIN_LEAD_MIN = 15
MAX_LEAD_MIN = 90  # the most a learned time may ask for
GRACE_MIN = 30  # into the hour, with nobody there yet, before the room is let go
REFRESH = timedelta(hours=6)  # how long a room's usual hours are kept before reading again


def next_arrival(
    usual: frozenset[tuple[int, int]], local_now: datetime
) -> tuple[datetime, float] | None:
    """The arrival to get ready for: when it begins, and the seconds until then.

    ``local_now`` is the house's wall clock (naive). The seconds are negative
    for an arrival hour that has begun and is still within its grace. Looks no
    further ahead than the longest lead.
    """
    this_hour = local_now.replace(minute=0, second=0, microsecond=0)
    for ahead in range(MAX_LEAD_MIN // 60 + 2):
        start = this_hour + timedelta(hours=ahead)
        before = start - timedelta(hours=1)
        if (start.weekday(), start.hour) not in usual or (before.weekday(), before.hour) in usual:
            continue
        secs = (start - local_now).total_seconds()
        if -GRACE_MIN * 60 < secs <= MAX_LEAD_MIN * 60:
            return start, secs
    return None


def lead_minutes(learned: int | None) -> int:
    """How long before the hour to start: the room's own time when it has one, within bounds."""
    if learned is None:
        return LEAD_MIN
    return min(max(learned, MIN_LEAD_MIN), MAX_LEAD_MIN)
