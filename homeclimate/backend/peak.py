"""Peak Hours: banking heat or cool ahead of the hours when electricity costs most.

Opt-in, off until it is switched on. For a while before the peak hours begin,
rooms that follow a band are worked toward the far side of it: cooled toward
their Heat To before a hot afternoon, warmed toward their Cool To before a
cold morning. During the peak they then drift back across the band before
anything has to run.

The rules, all here:

* never past the band: the banked target is a set depth inside the band's
  near edge, and never closer to the far edge than a degree and the deadband;
* only rooms following a band (the house band, or a banded schedule or
  occupancy target). A hold is left alone, and so is a single target;
* the direction comes from the forecast for the peak hours (the outside
  reading if there is none): cooling when it will be warmer out than the
  band's Cool To, heating when colder than its Heat To, otherwise nothing.

The engine (``CycleEngine._bank``) adds the rooms. Times are the house's
wall clock; temperatures are °F.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Any

import aiosqlite

from . import db, tz
from .user_errors import UserError, fixed

SETTING_KEY = "peak_hours"

DEFAULT_DEPTH_F = 2.0
MIN_DEPTH_F = 1.0
MAX_DEPTH_F = 5.0
MIN_LEAD_MIN = 30
MAX_LEAD_MIN = 180
FAR_EDGE_MARGIN_F = 1.0  # how close to the band's far edge banking may go, plus the deadband
_TIME = re.compile(r"([01]\d|2[0-3]):[0-5]\d")


class PeakError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


UNKNOWN_FIELD = fixed("Unknown peak hours setting")
BAD_ENABLED = fixed("enabled must be true or false")
BAD_TIME = fixed("start and end must be times like 14:00, and must differ")
BAD_DAYS = fixed("days must be a list of days, 0 (Monday) to 6 (Sunday), with at least one")
BAD_LEAD = fixed("lead_min must be a whole number from 30 to 180")
BAD_DEPTH = fixed("How far to bank must be between 1 and 5 °F (0.6 and 2.7 °C)")


@dataclass(frozen=True)
class Settings:
    enabled: bool = False
    start: str = "14:00"
    end: str = "19:00"
    days: tuple[int, ...] = (0, 1, 2, 3, 4)
    lead_min: int = 90
    peak_depth: float = DEFAULT_DEPTH_F

    def as_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "start": self.start,
            "end": self.end,
            "days": list(self.days),
            "lead_min": self.lead_min,
            "peak_depth": self.peak_depth,
        }


def _time(value: Any) -> time | None:
    if not isinstance(value, str) or not _TIME.fullmatch(value):
        return None
    return time(int(value[:2]), int(value[3:]))


def _checked(body: dict[str, Any], current: Settings) -> Settings:
    merged = {**current.as_dict(), **body}
    if set(body) - set(current.as_dict()):
        raise PeakError(UNKNOWN_FIELD)
    if not isinstance(merged["enabled"], bool):
        raise PeakError(BAD_ENABLED)
    start, end = _time(merged["start"]), _time(merged["end"])
    if start is None or end is None or start == end:
        raise PeakError(BAD_TIME)
    days = merged["days"]
    if (
        not isinstance(days, list)
        or not days
        or any(isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6 for d in days)
    ):
        raise PeakError(BAD_DAYS)
    lead = merged["lead_min"]
    if (
        isinstance(lead, bool)
        or not isinstance(lead, int)
        or not MIN_LEAD_MIN <= lead <= MAX_LEAD_MIN
    ):
        raise PeakError(BAD_LEAD)
    depth = merged["peak_depth"]
    if (
        isinstance(depth, bool)
        or not isinstance(depth, int | float)
        or not MIN_DEPTH_F <= depth <= MAX_DEPTH_F
    ):
        raise PeakError(BAD_DEPTH)
    return Settings(
        merged["enabled"],
        merged["start"],
        merged["end"],
        tuple(sorted(set(days))),
        lead,
        float(depth),
    )


async def load(conn: aiosqlite.Connection) -> Settings:
    raw = await db.get_system_setting(conn, SETTING_KEY, "")
    try:
        return _checked(json.loads(raw), Settings()) if raw else Settings()
    except (ValueError, TypeError, PeakError):
        return Settings()


async def update(conn: aiosqlite.Connection, body: dict[str, Any]) -> Settings:
    """Change some settings. ``peak_depth`` is already °F."""
    new = _checked(body, await load(conn))
    await db.set_system_setting(conn, SETTING_KEY, json.dumps(new.as_dict()))
    return new


@dataclass(frozen=True)
class Window:
    """The peak coming up, or under way: when to bank, and when it runs."""

    bank_from: datetime
    start: datetime
    end: datetime

    def banking(self, now: datetime) -> bool:
        return self.bank_from <= now < self.start

    def under_way(self, now: datetime) -> bool:
        return self.start <= now < self.end


def window(settings: Settings, now: datetime) -> Window | None:
    """Today's peak if banking for it or it is under way; else the next one. Aware datetimes."""
    start_t, end_t = _time(settings.start), _time(settings.end)
    assert start_t is not None and end_t is not None
    local = tz.to_local(now)
    for offset in range(-1, 8):
        day = local.date() + timedelta(days=offset)
        if day.weekday() not in settings.days:
            continue
        start = datetime.combine(day, start_t, tzinfo=local.tzinfo)
        end = datetime.combine(day, end_t, tzinfo=local.tzinfo)
        if end <= start:
            end += timedelta(days=1)  # runs past midnight
        if end > local:
            return Window(start - timedelta(minutes=settings.lead_min), start, end)
    return None


def direction(
    win: Window,
    heat_to: float,
    cool_to: float,
    outside: float | None,
    ahead: list[tuple[datetime, float]],
) -> str | None:
    """Which way to bank for a band: "cooling", "heating" or None.

    From the forecast for the peak hours; with none, from the outside reading.
    """
    during = [temp for at, temp in ahead if win.start <= at < win.end]
    if not during:
        if outside is None:
            return None
        during = [outside]
    if max(during) > cool_to:
        return "cooling"
    if min(during) < heat_to:
        return "heating"
    return None


def banked_target(
    way: str, heat_to: float, cool_to: float, depth: float, deadband: float = 0.0
) -> float:
    """Where a banded room is worked to before the peak: inside the band, always.

    Kept a degree and the room's deadband short of the band's far edge, so a
    run that carries a little past its target does not set off the other
    equipment; in a band too narrow for that, the middle of it.
    """
    margin = FAR_EDGE_MARGIN_F + deadband
    if way == "cooling":
        target = max(cool_to - depth, heat_to + margin)
    else:
        target = min(heat_to + depth, cool_to - margin)
    return target if heat_to <= target <= cool_to else (heat_to + cool_to) / 2
