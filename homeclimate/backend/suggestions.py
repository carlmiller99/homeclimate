"""Suggestions: advice from what has been recorded. Nothing here changes a setting.

Two kinds, each shown with the history it comes from:

* **Deadband**, per zone. A zone whose runs are many and short is being asked
  to hold its rooms more tightly than the equipment can do comfortably; a
  slightly wider deadband gives fewer, longer runs.
* **Schedule from occupancy**, per room. The hours of the week a room is
  usually occupied, from its occupancy sensors, as the blocks a schedule for
  it might have.

Nothing is suggested until there are two weeks of history to go on. All
temperatures are °F.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from statistics import median
from typing import Any

import aiosqlite

from . import db, tz, zones

MIN_DAYS = 14  # of history before anything is said
WINDOW_DAYS = 30  # how far back to look

# Deadband: runs this short, this often, are worth mentioning.
SHORT_RUN_MIN = 8.0
MANY_RUNS_A_DAY = 8.0
DEADBAND_STEP_F = 0.5
DEADBAND_MAX_F = 2.0

# Occupancy: an hour of the week counts as "usually occupied" when the room was
# occupied for this share of it, seen on at least this many separate weeks.
USUAL_SHARE = 0.6
MIN_WEEKS = 2


async def _deadbands(conn: aiosqlite.Connection, now: datetime) -> list[dict[str, Any]]:
    since = (now - timedelta(days=WINDOW_DAYS)).astimezone(UTC).replace(tzinfo=None).isoformat()
    async with conn.execute(
        "SELECT thermostat_entity_id AS tid, started_at, ended_at FROM cycle_logs"
        " WHERE started_at >= ? AND ended_at IS NOT NULL"
        # A run cut off (thermostat away, a door opened, the system switched
        # off) says nothing about the deadband; nor do the demonstration rows.
        " AND (ended_reason IS NULL OR (ended_reason NOT LIKE 'aborted:%'"
        " AND ended_reason != 'discarded_stale_on_restore'))"
        " AND id NOT LIKE 'demo-%' ORDER BY started_at",
        (since,),
    ) as cur:
        rows = await cur.fetchall()
    by_zone: dict[str, list[tuple[datetime, float]]] = {}
    for r in rows:
        try:
            start = datetime.fromisoformat(r["started_at"])
            minutes = (datetime.fromisoformat(r["ended_at"]) - start).total_seconds() / 60
        except (TypeError, ValueError):
            continue  # a damaged row is passed over
        by_zone.setdefault(r["tid"], []).append((start, minutes))
    out = []
    for tid, runs in sorted(by_zone.items()):
        days = (runs[-1][0] - runs[0][0]).total_seconds() / 86400
        if days < MIN_DAYS:
            continue
        a_day = len(runs) / days
        typical = median(m for _s, m in runs)
        profile = await zones.get_zone_profile(conn, tid)
        if profile is None:
            continue  # the zone has been removed; its history stays behind
        tc = await db.get_thermostat_config(conn, tid)
        rooms = await db.get_rooms_for_thermostat(conn, tid)
        if rooms and all(r.deadband_override is not None for r in rooms):
            continue  # every room has a deadband of its own: the zone's changes nothing
        if (
            typical >= SHORT_RUN_MIN
            or a_day < MANY_RUNS_A_DAY
            or tc.deadband + DEADBAND_STEP_F > DEADBAND_MAX_F
        ):
            continue
        out.append(
            {
                "kind": "deadband",
                "thermostat_entity_id": tid,
                "name": profile.name or tid,
                "current": tc.deadband,
                "suggested": tc.deadband + DEADBAND_STEP_F,
                "runs_a_day": round(a_day, 1),
                "typical_run_min": round(typical, 1),
                "days": round(days),
            }
        )
    return out


def _blocks(usual: set[tuple[int, int]]) -> list[dict[str, Any]]:
    """Hours of the week (weekday, hour) as blocks, with days that match grouped together."""
    by_day: dict[int, list[tuple[int, int]]] = {}
    for day in range(7):
        hours = sorted(h for d, h in usual if d == day)
        spans: list[tuple[int, int]] = []
        for hour in hours:
            if spans and spans[-1][1] == hour:
                spans[-1] = (spans[-1][0], hour + 1)
            else:
                spans.append((hour, hour + 1))
        by_day[day] = spans
    grouped: dict[tuple[int, int], list[int]] = {}
    for day, spans in by_day.items():
        for span in spans:
            grouped.setdefault(span, []).append(day)
    return [
        {"days": days, "start": f"{start:02d}:00", "end": f"{end % 24:02d}:00"}
        for (start, end), days in sorted(grouped.items(), key=lambda g: (g[1], g[0]))
    ]


async def _room_keys(conn: aiosqlite.Connection) -> dict[str, int]:
    async with conn.execute("SELECT key, value FROM room_reading_keys WHERE kind = 'room'") as cur:
        return {r["value"]: r["key"] for r in await cur.fetchall()}


async def _usual(
    conn: aiosqlite.Connection, room_key: int, now: datetime
) -> tuple[set[tuple[int, int]], int] | None:
    """The (weekday, hour) cells a room is usually occupied in, and the days of history.

    None until there are two weeks of occupancy readings to go on.
    """
    since = int((now - timedelta(days=WINDOW_DAYS)).timestamp())
    # Only the two columns needed: a month of readings is thousands of rows a room.
    async with conn.execute(
        "SELECT ts, occupied FROM room_readings WHERE room_key = ? AND ts >= ?"
        " AND occupied IS NOT NULL ORDER BY ts",
        (room_key, since),
    ) as cur:
        samples = [
            (datetime.fromtimestamp(r["ts"], UTC), r["occupied"]) for r in await cur.fetchall()
        ]
    if not samples or (samples[-1][0] - samples[0][0]).total_seconds() < MIN_DAYS * 86400:
        return None
    # (weekday, hour) → [occupied readings, readings, the weeks it was seen in]
    seen: dict[tuple[int, int], list[Any]] = {}
    for ts, occupied in samples:
        local = tz.to_local(ts)
        cell = seen.setdefault((local.weekday(), local.hour), [0, 0, set()])
        cell[1] += 1
        if occupied:
            cell[0] += 1
            cell[2].add(local.isocalendar()[:2])  # occupied in this week
    usual = {
        key
        for key, (count, total, weeks) in seen.items()
        if len(weeks) >= MIN_WEEKS and count / total >= USUAL_SHARE
    }
    return usual, round((samples[-1][0] - samples[0][0]).total_seconds() / 86400)


async def usual_hours(
    conn: aiosqlite.Connection, room_ids: list[str], now: datetime
) -> dict[str, frozenset[tuple[int, int]]]:
    """For each of these rooms with enough history: the hours of the week it is usually used."""
    keys = await _room_keys(conn)
    out: dict[str, frozenset[tuple[int, int]]] = {}
    for room_id in room_ids:
        found = await _usual(conn, keys.get(room_id, -1), now)
        if found is not None and found[0]:
            out[room_id] = frozenset(found[0])
    return out


async def _schedules(conn: aiosqlite.Connection, now: datetime) -> list[dict[str, Any]]:
    keys = await _room_keys(conn)
    out = []
    for room in await db.get_all_rooms(conn):
        found = await _usual(conn, keys.get(room.id, -1), now)
        if found is None or not found[0]:
            continue
        usual, days = found
        out.append(
            {
                "kind": "schedule",
                "room_id": room.id,
                "name": room.name,
                "days": days,
                "hours_a_week": len(usual),
                "blocks": _blocks(usual),
            }
        )
    return out


async def build(conn: aiosqlite.Connection, *, now: datetime) -> dict[str, Any]:
    """Everything the Suggestions card shows."""
    return {
        "min_days": MIN_DAYS,
        "window_days": WINDOW_DAYS,
        "zones": await _deadbands(conn, now),
        "rooms": await _schedules(conn, now),
    }
