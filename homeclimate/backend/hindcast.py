"""Smart Learning: what a room's model would have said, set against what happened.

For one day of a room's readings, each point is predicted from the reading an
hour before it, using the model and what was recorded in between: the weather,
the thermostat's reading, the sun, and how much the equipment ran with the
room's vent open. A room whose line tracks the measured one has a model that
can be trusted to time a warm-up; one that drifts apart does not yet.

Temperatures are °F.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from . import learning, room_model

AHEAD_STEPS = 12  # one hour of 5-minute readings
EVERY_STEPS = 3  # one point every 15 minutes
STEP_H = learning.SAMPLE_EVERY_MIN / 60


def _usable(run: list[learning.RoomSample]) -> bool:
    """An unbroken hour the model can speak for: same zone, nothing open, no fire, no strips."""
    first = run[0]
    return all(
        (b.ts - a.ts).total_seconds() == learning.SAMPLE_EVERY_MIN * 60
        for a, b in zip(run, run[1:], strict=False)
    ) and all(
        s.room_temp is not None
        and s.outside_temp is not None
        and not s.opening
        and not s.fireplace
        and not s.aux_heat
        and s.hvac_action in room_model.ACTIONS
        and s.thermostat_entity_id == first.thermostat_entity_id
        for s in run
    )


def _predict(
    model: room_model.RoomModel,
    run: list[learning.RoomSample],
    sun_at: Callable[[datetime], float] | None,
) -> float:
    """Where the model puts the room at the end of ``run``, starting from its first reading."""
    temp = float(run[0].room_temp or 0.0)
    for s in run[:-1]:
        share = 1.0 if s.vent_open is None else s.vent_open
        action = room_model.ACTIONS[s.hvac_action]
        rate = model.rate(
            temp,
            float(s.outside_temp or 0.0),
            s.zone_temp,
            None,
            0.0 if sun_at is None else sun_at(s.ts),
        )
        if action == "heating":
            rate += model.heat * share
        elif action == "cooling":
            rate += model.cool * share
        temp += rate * STEP_H
    return temp


def build(
    model: room_model.RoomModel | None,
    samples: list[learning.RoomSample],
    *,
    start: datetime,
    end: datetime,
    sun_at: Callable[[datetime], float] | None = None,
) -> dict[str, Any]:
    """Points from ``start`` to ``end`` (UTC), and how far off the model typically was.

    ``samples`` must reach back an hour before ``start``, oldest first.
    """
    points: list[dict[str, Any]] = []
    misses: list[float] = []
    for i, s in enumerate(samples):
        if not (start <= s.ts < end) or s.room_temp is None:
            continue
        if int(s.ts.timestamp()) % (EVERY_STEPS * learning.SAMPLE_EVERY_MIN * 60):
            continue
        predicted = None
        if model is not None and model.fitted_at is not None and i >= AHEAD_STEPS:
            run = samples[i - AHEAD_STEPS : i + 1]
            if _usable(run):
                predicted = round(_predict(model, run, sun_at), 2)
                misses.append(abs(predicted - s.room_temp))
        points.append(
            {"at": s.ts.isoformat(), "measured": round(s.room_temp, 2), "predicted": predicted}
        )
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "points": points,
        "typical_miss": round(sum(misses) / len(misses), 2) if misses else None,
        "predicted_points": len(misses),
    }


def lookback(start: datetime) -> datetime:
    """How far back readings are needed to predict from the first point of the day."""
    return start - timedelta(hours=1, minutes=learning.SAMPLE_EVERY_MIN)
