"""How far the forecast is usually off, by hour of the day.

Each hour, the outside temperature that was recorded is compared with what the
forecast said for that hour about six hours earlier. The differences are kept
as a running average for each hour of the day (in the house's time zone). Once
there are enough comparisons the average is added to the forecast, so a
weather source that always reads warm in the afternoon stops misleading
anything that plans from it.

Nothing is stored per comparison: 24 small rows hold the averages, and one
setting remembers the last hour that was scored.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import db, tz
from .forecast import TEMP_SCALE, Hour

NEEDED = 48  # comparisons before the correction is used
LEAD = timedelta(hours=6)  # score the forecast made about this long before
LEAD_AT_LEAST = timedelta(hours=3)
LEAD_AT_MOST = timedelta(hours=12)  # an older forecast says nothing about a 6-hour one
SHRINK = 8  # an hour's own average counts as n against this many of the overall one
MAX_OFFSET_F = 8.0  # never move the forecast further than this
LOOK_BACK_HOURS = 48  # how far back unscored hours are still scored
WINDOW = 30  # an hour's average follows about its last 30 days
READING_WITHIN_S = 900  # an outside reading this close to the hour counts
MAX_ERROR_F = 30.0  # a difference past this is a broken sensor, not weather
SCORED_THROUGH = "forecast_scored_through"


@dataclass(frozen=True)
class HourBias:
    n: int
    mean_error: float  # recorded minus forecast, °F
    mean_abs: float  # how far off the forecast was
    mean_abs_corrected: float  # how far off it was once corrected
    n_corrected: int = 0  # comparisons made while the correction was in use


@dataclass(frozen=True)
class Bias:
    by_hour: dict[int, HourBias]

    @property
    def comparisons(self) -> int:
        return sum(h.n for h in self.by_hour.values())

    @property
    def ready(self) -> bool:
        return self.comparisons >= NEEDED

    @property
    def mean_error(self) -> float | None:
        n = self.comparisons
        if not n:
            return None
        return sum(h.mean_error * h.n for h in self.by_hour.values()) / n

    def _average(self, field: str) -> float | None:
        n = self.comparisons
        if not n:
            return None
        return float(sum(getattr(h, field) * h.n for h in self.by_hour.values()) / n)

    @property
    def mean_abs(self) -> float | None:
        return self._average("mean_abs")

    @property
    def mean_abs_corrected(self) -> float | None:
        """Over the hours compared since the correction began; None before then."""
        n = sum(h.n_corrected for h in self.by_hour.values())
        if not n:
            return None
        return sum(h.mean_abs_corrected * h.n_corrected for h in self.by_hour.values()) / n

    def offset(self, hour_of_day: int) -> float:
        """What to add to a forecast temperature for that local hour; 0 until ready.

        An hour's own average is pulled toward the overall one until it has
        been seen often enough to be trusted, and the result is capped: a few
        odd days, or a sensor in the sun, must not swing the forecast far.
        """
        if not self.ready:
            return 0.0
        overall = self.mean_error or 0.0
        found = self.by_hour.get(hour_of_day)
        n = found.n if found is not None else 0
        own = found.mean_error if found is not None else overall
        value = (n * own + SHRINK * overall) / (n + SHRINK)
        return max(-MAX_OFFSET_F, min(MAX_OFFSET_F, value))

    def correct(self, hours: list[Hour]) -> list[Hour]:
        """The forecast with each hour's usual error added."""
        if not self.ready:
            return hours
        return [
            Hour(
                h.at,
                round(h.temp + self.offset(tz.to_local(h.at).hour), 2),
                h.cloud_pct,
                h.precip_pct,
                h.condition,
            )
            for h in hours
        ]


async def load(conn: aiosqlite.Connection) -> Bias:
    async with conn.execute("SELECT * FROM forecast_bias") as cur:
        rows = await cur.fetchall()
    return Bias(
        {
            r["hour_of_day"]: HourBias(
                r["n"],
                r["mean_error"],
                r["mean_abs"],
                r["mean_abs_corrected"],
                r["n_corrected"],
            )
            for r in rows
        }
    )


async def _recorded(conn: aiosqlite.Connection, at: int) -> float | None:
    """The outside temperature recorded nearest that moment, °F."""
    # Asked room by room so the table's own ordering (room, time) is used.
    async with conn.execute(
        "SELECT outside_temp FROM room_readings"
        " WHERE room_key IN (SELECT key FROM room_reading_keys WHERE kind='room')"
        " AND ts BETWEEN ? AND ? AND outside_temp IS NOT NULL"
        " ORDER BY ABS(ts - ?) LIMIT 1",
        (at - READING_WITHIN_S, at + READING_WITHIN_S, at),
    ) as cur:
        row = await cur.fetchone()
    return None if row is None else row["outside_temp"] / TEMP_SCALE


async def _forecast_for(conn: aiosqlite.Connection, hour: int) -> tuple[int, float] | None:
    """(the moment, °F) forecast for that clock hour about six hours before it.

    A weather source in a half-hour time zone gives its hours on the half
    hour, so any forecast moment inside the clock hour counts.
    """
    async with conn.execute(
        "SELECT at, temp FROM forecast_snapshots"
        " WHERE at BETWEEN ? AND ? AND issued BETWEEN at - ? AND at - ?"
        " ORDER BY ABS(at - issued - ?), at LIMIT 1",
        (
            hour,
            hour + 3599,
            int(LEAD_AT_MOST.total_seconds()),
            int(LEAD_AT_LEAST.total_seconds()),
            int(LEAD.total_seconds()),
        ),
    ) as cur:
        row = await cur.fetchone()
    return None if row is None else (row["at"], row["temp"] / TEMP_SCALE)


_scoring = asyncio.Lock()


async def score(conn: aiosqlite.Connection, *, now: datetime) -> int:
    """Compare every finished hour not yet scored. Returns how many were compared."""
    async with _scoring:
        return await _score(conn, now)


async def _score(conn: aiosqlite.Connection, now: datetime) -> int:
    this_hour = int(now.timestamp()) // 3600 * 3600
    last = this_hour - 3600  # the latest hour whose reading can exist
    stored = await db.get_system_setting(conn, SCORED_THROUGH, "")
    try:
        done = int(stored)
    except ValueError:
        done = 0
    if done >= last:
        # Up to date, or the clock has gone backwards: wait for it to catch up
        # rather than score the same hours again.
        return 0
    # Never further back than two days.
    start = max(done + 3600, last - (LOOK_BACK_HOURS - 1) * 3600)
    bias = await load(conn)
    by_hour = dict(bias.by_hour)
    compared = 0
    for hour in range(start, last + 1, 3600):
        said = await _forecast_for(conn, hour)
        if said is None:
            continue
        at, forecast_temp = said
        actual = await _recorded(conn, at)
        if actual is None:
            continue
        error = actual - forecast_temp
        if abs(error) > MAX_ERROR_F:
            continue
        hour_of_day = tz.to_local(datetime.fromtimestamp(at, UTC)).hour
        # Scored against the correction as it stood before this hour was seen.
        before = Bias(by_hour)
        was = by_hour.get(hour_of_day)
        n = 1 if was is None else was.n + 1
        mean_error = (
            error if was is None else was.mean_error + (error - was.mean_error) / min(n, WINDOW)
        )
        mean_abs = (
            abs(error)
            if was is None
            else was.mean_abs + (abs(error) - was.mean_abs) / min(n, WINDOW)
        )
        n_corrected = was.n_corrected if was is not None else 0
        mean_abs_corrected = was.mean_abs_corrected if was is not None else 0.0
        if before.ready:
            # Only hours the correction was actually applied to count toward
            # how good it has been.
            n_corrected += 1
            off = abs(error - before.offset(hour_of_day))
            mean_abs_corrected += (off - mean_abs_corrected) / min(n_corrected, WINDOW)
        by_hour[hour_of_day] = HourBias(n, mean_error, mean_abs, mean_abs_corrected, n_corrected)
        compared += 1
    if compared:
        await conn.executemany(
            "INSERT OR REPLACE INTO forecast_bias"
            "(hour_of_day, n, mean_error, mean_abs, mean_abs_corrected, n_corrected)"
            " VALUES(?,?,?,?,?,?)",
            [
                (h, b.n, b.mean_error, b.mean_abs, b.mean_abs_corrected, b.n_corrected)
                for h, b in by_hour.items()
            ],
        )
    await db.set_system_setting(conn, SCORED_THROUGH, str(last))
    await conn.commit()
    return compared


def snapshot(bias: Bias, *, in_use: bool) -> dict[str, Any]:
    """What the Forecasts section shows about accuracy. Differences are °F deltas."""

    def rounded(value: float | None) -> float | None:
        return None if value is None else round(value, 2)

    return {
        "comparisons": bias.comparisons,
        "needed": NEEDED,
        "ready": bias.ready,
        "in_use": in_use and bias.ready,
        "mean_error": rounded(bias.mean_error),
        "mean_abs": rounded(bias.mean_abs),
        "mean_abs_corrected": rounded(bias.mean_abs_corrected),
        "by_hour": [
            {"hour": hour, "n": found.n, "offset": round(bias.offset(hour), 2)}
            for hour, found in sorted(bias.by_hour.items())
        ],
    }
