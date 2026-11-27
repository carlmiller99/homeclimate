"""Stop Early to Avoid Overshoot: close a room's vent a little before its target.

A room keeps moving after its vent closes: the ducts are still warm (or cold),
and a closed vent leaks while the equipment runs for other rooms. How far it
runs on is learned per room, separately for heating and cooling, from what its
temperature did in the half hour after each recent close.

The lead used is deliberately cautious: the run-on the room managed at least
three times in four, never more than half the room's own deadband, and never
more than ``MAX_LEAD_F``. Half, because the other half is the room's
hysteresis: a room closed early must be able to dip a little without being
opened again or calling for a new run.

All temperatures are °F differences.
"""

from __future__ import annotations

import json
from bisect import bisect_left, bisect_right
from datetime import datetime, timedelta
from typing import Any

import aiosqlite

from . import db, learning, room_model

LEVELS = ("off", "watch", "on")

WINDOW_DAYS = 21  # how far back closes are read
AFTER = timedelta(minutes=30)  # how long after a close the run-on is watched
MIN_RUNS = 5  # closes needed, per room and mode, before anything is used
MAX_LEAD_F = 1.5
MIN_LEAD_F = 0.2  # a smaller run-on is not worth acting on
BAND_SHARE = 0.5  # the most of a room's deadband a lead may use
SHARE = 0.25  # the lead is the run-on reached in all but this share of closes
KEY = "learn_stop_early"
MODES = ("heating", "cooling")


def _run_on(
    samples: list[learning.RoomSample],
    times: list[float],
    closed: float,
    at_close: float | None,
    mode: str,
) -> float | None:
    """How far the room ran on after a close at ``closed`` (epoch seconds); None if unknown.

    Measured from the room's temperature at the close itself where the run
    recorded it; otherwise from the reading just before, which is a little
    stale and so a little generous. The half hour is cut short at the first
    reading in which the room is being heated or cooled again: what happens
    after that is the next run's doing, not run-on.
    """
    at = bisect_right(times, closed) - 1
    if at_close is None:
        if at < 0 or closed - times[at] > learning.SAMPLE_EVERY_MIN * 60 + 60:
            return None
        at_close = float(samples[at].room_temp or 0.0)
    after: list[float] = []
    cut = False
    for s in samples[at + 1 : bisect_right(times, closed + AFTER.total_seconds())]:
        served = s.vent_open is None or s.vent_open > 0
        if served and room_model.ACTIONS.get(s.hvac_action) == mode:
            cut = True
            break
        after.append(float(s.room_temp or 0.0))
    # The half hour must be covered, or a peak could have been missed. One cut
    # short by the next run still counts once it has shown ten minutes.
    needed = 2 if cut else AFTER.total_seconds() / (learning.SAMPLE_EVERY_MIN * 60) - 1
    if len(after) < needed:
        return None
    moved = (max(after) - at_close) if mode == "heating" else (at_close - min(after))
    return max(moved, 0.0)


def lead_from(run_ons: list[float]) -> float:
    """The lead a room's run-ons support: 0 until there are enough of them."""
    if len(run_ons) < MIN_RUNS:
        return 0.0
    ordered = sorted(run_ons)
    value = ordered[int(len(ordered) * SHARE)]
    return 0.0 if value < MIN_LEAD_F else round(min(value, MAX_LEAD_F), 2)


async def learn(conn: aiosqlite.Connection, *, now: datetime) -> dict[str, dict[str, Any]]:
    """Work out each room's lead from its recent closes, store it, and return it."""
    since = now - timedelta(days=WINDOW_DAYS)
    async with conn.execute(
        """SELECT rcs.room_id, rcs.vent_closed_at, rcs.temp_at_end, cl.mode
           FROM room_cycle_states rcs JOIN cycle_logs cl ON cl.id = rcs.cycle_id
           WHERE rcs.vent_closed_at IS NOT NULL AND rcs.role = 'active'
             AND cl.mode IN ('heating', 'cooling') AND rcs.vent_closed_at >= ?""",
        (db._dts(since),),
    ) as cur:
        closes = await cur.fetchall()
    by_room: dict[str, list[tuple[float, str, float | None]]] = {}
    for row in closes:
        # Stored without a zone, and UTC: read through ``db._dt`` so the house's
        # own zone (the process's TZ) is never applied to it.
        by_room.setdefault(row["room_id"], []).append(
            (
                db._dt_required(row["vent_closed_at"]).timestamp(),
                row["mode"],
                row["temp_at_end"],
            )
        )
    out: dict[str, dict[str, Any]] = {}
    for room_id, found in by_room.items():
        # A door or window open, or a fire lit, moves the room for its own reasons.
        samples = [
            s
            for s in await learning.load(conn, room_id=room_id, since=since)
            if s.room_temp is not None
        ]
        disturbed = [s.ts.timestamp() for s in samples if s.opening or s.fireplace]
        times = [s.ts.timestamp() for s in samples]
        entry: dict[str, Any] = {}
        for mode in MODES:
            runs = []
            for closed, closed_mode, at_close in found:
                if closed_mode != mode:
                    continue
                end = closed + AFTER.total_seconds()
                if bisect_left(disturbed, closed) != bisect_right(disturbed, end):
                    continue
                moved = _run_on(samples, times, closed, at_close, mode)
                if moved is not None:
                    runs.append(moved)
            entry[mode] = {"lead": lead_from(runs), "runs": len(runs)}
        out[room_id] = entry
    await db.set_system_setting(conn, KEY, json.dumps(out, separators=(",", ":")))
    return out


async def load(conn: aiosqlite.Connection) -> dict[str, dict[str, Any]]:
    """What ``learn`` last stored; empty when it has not run or the value is unreadable."""
    raw = await db.get_system_setting(conn, KEY, "")
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def lead(table: dict[str, dict[str, Any]], room_id: str, mode: str, band: float) -> float:
    """The lead to use for a room now: what it learned, at most half its deadband."""
    try:
        learned = float(table[room_id][mode]["lead"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    value = round(min(learned, band * BAND_SHARE, MAX_LEAD_F), 2)
    return value if value >= MIN_LEAD_F else 0.0


def stops_now(
    lead_f: float, mode: str, temp: float, target: float, started_at: float | None
) -> bool:
    """Whether a room this close to its target should be closed early.

    Only once it has moved at least the lead this run: a room that began
    within the lead of its target has not built up the run-on the lead counts
    on, and closing it at once would be a call answered with nothing.
    """
    if lead_f <= 0 or started_at is None:
        return False
    if mode == "heating":
        return temp + lead_f >= target and temp - started_at >= lead_f
    if mode == "cooling":
        return temp - lead_f <= target and started_at - temp >= lead_f
    return False
