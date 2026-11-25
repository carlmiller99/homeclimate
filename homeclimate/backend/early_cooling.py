"""Early Cooling: cool a room a little before a warm afternoon makes it necessary.

A room following a band is normally left alone until it passes its Cool To.
On a day that is still warming, that moment comes when the equipment is at
its least efficient and every room wants it at once. When a room's own model
says it will pass its Cool To within the next three hours if left alone, and
the forecast says the afternoon will be warmer than now, the room is cooled a
little into its band now instead.

It is a prediction, so the rooms it adds give way to any room that asks for
itself, and it never goes outside the band. All temperatures are °F.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta

from . import coasting, room_model

LEVELS = ("off", "watch", "on")

LOOK_AHEAD_MIN = 180  # how far ahead a breach is looked for
DEPTH_F = 1.5  # how far below its Cool To a room is cooled
WARMING_BY_F = 3.0  # the forecast has to rise at least this much over the look-ahead


def warming(
    outside: float, ahead: Sequence[tuple[datetime, float]], now: datetime, cool_to: float
) -> float | None:
    """The warmest the coming three hours are forecast to be, when that calls for this.

    None unless it is warmer than the room's Cool To and at least 3 °F warmer
    than the forecast for now: early cooling is for a day still on its way up,
    not for one that has peaked.
    """
    until = now + timedelta(minutes=LOOK_AHEAD_MIN)
    coming = [temp for at, temp in ahead if now < at <= until]
    if not coming:
        return None
    current = coasting._between(sorted(ahead), now)
    peak = max(coming)
    if peak <= cool_to or peak - current < WARMING_BY_F:
        return None
    # As the outlook does: the forecast shifted to agree with the sensor now.
    return peak + (outside - current)


NEAR_F = 1.0  # this close to its Cool To, a room counts as about to pass it


def warm_ahead(
    model: room_model.RoomModel | None,
    *,
    temp: float,
    cool_to: float,
    outside: float | None,
    ahead: Sequence[tuple[datetime, float]],
    now: datetime,
    zone: float | None = None,
) -> bool:
    """Whether a room is about to be too warm: what a sunlit shade is closed ahead of.

    Only when it is warmer outside than that top (in the cold, sun through a
    window is welcome). Then: within 1 °F of the top already, or, on a day
    still warming, expected by its own model to pass it within three hours.
    ``temp`` and ``cool_to`` are raw readings (no room offset).
    """
    if outside is None or outside <= cool_to:
        return False
    if temp >= cool_to - NEAR_F:
        return True
    if (
        model is None
        or not coasting.usable(model, now)
        or warming(outside, ahead, now, cool_to) is None
    ):
        return False
    outlook = coasting.Outlook(now, outside, ahead)
    return breach_in(model, temp=temp, cool_to=cool_to, outlook=outlook, zone=zone) is not None


def breach_in(
    model: room_model.RoomModel,
    *,
    temp: float,
    cool_to: float,
    outlook: coasting.Outlook,
    zone: float | None = None,
) -> int | None:
    """Minutes until the room, left alone, passes its Cool To; None if not within three hours."""
    if temp >= cool_to:
        return 0
    return coasting.minutes_alone(
        model, temp=temp, goal=cool_to, outlook=outlook, within_min=LOOK_AHEAD_MIN, zone=zone
    )
