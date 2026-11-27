"""Stop Early to Avoid Overshoot: close a room's vent a little before its target.

A room keeps moving after its vent closes: the ducts are still warm (or cold),
and a closed vent leaks while the equipment runs for other rooms. How far it
runs on is learned per room, separately for heating and cooling, from what its
temperature did in the half hour after each recent close.

The lead used is deliberately cautious: the run-on the room managed at least
three times in four, never more than the room's own deadband (so a room that
does not coast the rest of the way still ends inside its comfort band and
does not call again), and never more than ``MAX_LEAD_F``.

All temperatures are °F differences.
"""

from __future__ import annotations

import json
from bisect import bisect_left, bisect_right
from datetime import datetime, timedelta
from typing import Any

import aiosqlite

from . import db, learning

LEVELS = ("off", "watch", "on")

WINDOW_DAYS = 21  # how far back closes are read
AFTER = timedelta(minutes=30)  # how long after a close the run-on is watched
MIN_RUNS = 5  # closes needed, per room and mode, before anything is used
MAX_LEAD_F = 1.5
MIN_LEAD_F = 0.2  # a smaller run-on is not worth acting on
SHARE = 0.25  # the lead is the run-on reached in all but this share of closes
KEY = "learn_stop_early"
MODES = ("heating", "cooling")


def _run_on(times: list[float], temps: list[float], closed: float, mode: str) -> float | None:
    """How far the room ran on after a close at ``closed`` (epoch seconds); None if unknown."""
    at = bisect_right(times, closed) - 1
    if at < 0 or closed - times[at] > learning.SAMPLE_EVERY_MIN * 60 + 60:
        return None
    lo, hi = bisect_right(times, closed), bisect_right(times, closed + AFTER.total_seconds())
    after = temps[lo:hi]
    # The half hour must be covered, or a peak could have been missed.
    if len(after) < AFTER.total_seconds() / (learning.SAMPLE_EVERY_MIN * 60) - 1:
        return None
    moved = (max(after) - temps[at]) if mode == "heating" else (temps[at] - min(after))
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
        """SELECT rcs.room_id, rcs.vent_closed_at, cl.mode
           FROM room_cycle_states rcs JOIN cycle_logs cl ON cl.id = rcs.cycle_id
           WHERE rcs.vent_closed_at IS NOT NULL AND rcs.role = 'active'
             AND cl.mode IN ('heating', 'cooling') AND rcs.vent_closed_at >= ?""",
        (since.isoformat(),),
    ) as cur:
        closes = await cur.fetchall()
    by_room: dict[str, list[tuple[float, str]]] = {}
    for row in closes:
        by_room.setdefault(row["room_id"], []).append(
            (datetime.fromisoformat(row["vent_closed_at"]).timestamp(), row["mode"])
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
        temps = [float(s.room_temp or 0.0) for s in samples]
        entry: dict[str, Any] = {}
        for mode in MODES:
            runs = []
            for closed, closed_mode in found:
                if closed_mode != mode:
                    continue
                end = closed + AFTER.total_seconds()
                if bisect_left(disturbed, closed) != bisect_right(disturbed, end):
                    continue
                moved = _run_on(times, temps, closed, mode)
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
    """The lead to use for a room now: what it learned, never more than its deadband."""
    try:
        learned = float(table[room_id][mode]["lead"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    value = min(learned, band, MAX_LEAD_F)
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
