"""Today's plan, for the Dashboard: what the weather asks of the house and what is coming up.

Read-only. Nothing here commands anything; it puts what other parts already
know in one place:

* the next 24 forecast hours, each marked as one the house would need heat
  in, need cooling in, or coast through. An hour needs heat when it is colder
  outside than the house band's Heat To, cooling when it is warmer than its
  Cool To (the same thresholds One Side Per Building uses);
* the next few things on the clock: schedule blocks starting, and the peak
  hours with the time banking for them begins;
* yesterday in a sentence (the same sentence the daily summary sends).

Temperatures are °F; times are ISO instants.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import building_mode, db, forecast, forecast_bias, house, notify, peak, tz
from .engine.room_manager import _next_schedule_block

HOURS = 24
MAX_EVENTS = 6


def need(temp: float, heat_below: float, cool_above: float) -> str:
    """What an hour at ``temp`` outside asks for: "heat", "cool" or "coast"."""
    if temp < heat_below:
        return "heat"
    if temp > cool_above:
        return "cool"
    return "coast"


async def build(conn: aiosqlite.Connection, *, now: datetime) -> dict[str, Any]:
    the_house = await house.load(conn)
    band = the_house.outer_band()
    heat_below = band.heat_to if band else building_mode.DEFAULT_HEAT_BELOW_F
    cool_above = band.cool_to if band else building_mode.DEFAULT_COOL_ABOVE_F
    hours, fetched = await forecast.load(conn, now=now)
    if (await forecast.get_settings(conn))["correct"]:
        hours = (await forecast_bias.load(conn)).correct(hours)
    until = now + timedelta(hours=HOURS)
    strip = [
        {"at": h.at.isoformat(), "temp": h.temp, "need": need(h.temp, heat_below, cool_above)}
        for h in hours[:HOURS]
    ]

    events: list[dict[str, Any]] = []
    by_room: dict[str, list] = {}
    for sched in await db.get_all_schedules(conn):
        by_room.setdefault(sched.room_id, []).append(sched)
    for room in await db.get_all_rooms(conn):
        switches = the_house.switches(room.id)
        found = (
            _next_schedule_block(by_room.get(room.id, []), now)
            if switches.in_use and switches.use_schedules
            else None
        )
        if found is None or found[0] > HOURS * 3600:
            continue
        secs, block, _label = found
        events.append(
            {
                # The block's own wall-clock start in the house's zone, so a
                # clock change between now and then does not shift it.
                "at": (tz.to_local_naive(now) + timedelta(seconds=secs))
                .replace(tzinfo=tz.get_timezone())
                .astimezone(UTC),
                "kind": "schedule",
                "room_id": room.id,
                "room": room.name,
                "target": block.target_temp,
                "cool_to": the_house.cool_to("schedule", block.id, block.target_temp),
            }
        )
    settings = await peak.load(conn)
    window = peak.window(settings, now) if settings.enabled else None
    if window is not None:
        for at, kind in (
            (window.bank_from, "peak_bank"),
            (window.start, "peak_start"),
            (window.end, "peak_end"),
        ):
            if now < at <= until:
                events.append({"at": at.astimezone(UTC), "kind": kind})
    events.sort(key=lambda e: e["at"])
    events = [{**e, "at": e["at"].isoformat()} for e in events[:MAX_EVENTS]]
    return {
        "now": now.isoformat(),
        "heat_below": heat_below,
        "cool_above": cool_above,
        "forecast_fetched_at": None if fetched is None else fetched.isoformat(),
        "hours": strip,
        "events": events,
        "yesterday": await notify.summary(conn, now=now),
    }
