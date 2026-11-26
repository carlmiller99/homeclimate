"""Fan: moving air between a zone's rooms when heating or cooling is not the answer.

A building held to heating leaves a room that is too warm to cool by itself
(and one held to cooling leaves a cold room to warm by itself). When other
rooms of the same zone are closer to where that room should be, running the
air handler's fan with nothing else on mixes the two. That is all this does.

Per zone, set in Smart Control: ``off`` (the default), ``watch`` (what it
would have done is logged, the fan is not touched) or ``on``.

The rules, all here:

* only a zone that is idle and held to one side by its building (Heat Only,
  Cool Only, or Auto set to On): the fan works the *other* side, the one the
  building is not serving;
* a room at least ``PAST_F`` past its target on that side (``NARROW_PAST_F``
  when its two targets are the same number, so the ordinary overshoot of a
  cycle is not a reason), with another room of the zone at least ``SPREAD_F``
  closer to it that is not itself past its own target. Rooms paused by an
  open door or window count for nothing, either way;
* it stops when the room is back at its target, when the rooms are within
  ``KEEP_SPREAD_F`` of each other, when a cycle starts, or after ``CAP`` in
  any ``WINDOW``;
* not for ``AFTER_RUN`` after any run: after cooling the coil is wet, and
  after either the rooms are still settling;
* a zone with an outside air intake only runs the fan while outside air would
  help the room, since the fan draws it in. "Not sure" is treated as none.

The fan is switched with the thermostat's own fan setting (``on`` / ``auto``).
One that somebody else turned on is left alone. One that HomeClimate turned
on is always set back to ``auto``, whatever Home Assistant last reported, and
is remembered until the thermostat has taken that.

``Manager.start_test`` runs the fan for ``TEST_LENGTH`` to see whether the
zone's rooms move toward the outside temperature. It is a hint and no more:
mixing, and ducts in an attic or crawl space, move temperatures too.
Temperatures are °F.
"""

from __future__ import annotations

import json
import logging
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

import aiosqlite

from . import db
from .user_errors import UserError, fixed

log = logging.getLogger(__name__)

LEVELS = ("off", "watch", "on")
INTAKES = ("yes", "no", "unsure")
PAST_F = 0.5
# For a room kept to one number: a cycle overshoots it by about this much.
NARROW_PAST_F = 2.5
SPREAD_F = 1.5
KEEP_SPREAD_F = 0.75
CAP = timedelta(minutes=30)
WINDOW = timedelta(hours=1)
AFTER_RUN = timedelta(minutes=15)
TEST_LENGTH = timedelta(minutes=10)
TEST_MIN_DIFFERENCE_F = 10.0
TEST_MOVED_F = 0.5
# The zones whose fan HomeClimate turned on, so a restart can turn them back.
RUNNING_SETTING = "fan_running"
TEST_SETTING = "fan_test:"


class FanError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


ZONE_UNKNOWN = fixed("That zone was not found, or has no rooms yet")
NO_FAN_SETTING = fixed("This thermostat has no fan setting HomeClimate can switch")
TEST_BUSY = fixed("Wait until the zone is idle and its fan has stopped, then try again")
TEST_BLOCKED = fixed("The fan cannot be tested while the system is off or paused")
TEST_NO_OUTSIDE = fixed(
    "The test needs an outside temperature and a room temperature for this zone"
)
TEST_TOO_CLOSE = fixed(
    "Inside and outside are too close to tell. Try when they are at least 10 °F (5.6 °C) apart"
)
TEST_RUNNING = fixed("A test is already running for this zone")
FAN_FAILED = fixed("The thermostat did not accept the fan change")


@dataclass(frozen=True)
class RoomNow:
    """One room of a zone, as far as the fan is concerned."""

    room_id: str
    name: str
    temp: float | None
    # What the room is kept between; None for a room that follows nothing.
    heat_to: float | None = None
    cool_to: float | None = None
    paused: bool = False


@dataclass(frozen=True)
class Want:
    """A reason to run the fan: one room, and the rooms it would be mixed with."""

    room_id: str
    room_name: str
    helpers: tuple[str, ...]
    past: float
    spread: float


def decide(
    rooms: list[RoomNow],
    passive: str,
    *,
    running: bool,
    intake: bool = False,
    outside: float | None = None,
    for_room: str | None = None,
) -> Want | None:
    """The room the fan should run for, if any.

    ``passive`` is the side the building is not serving: "cooling" when it is
    held to heating, so the rooms to help are the ones that are too warm.
    """
    warm = passive == "cooling"
    best: Want | None = None
    for room in rooms:
        target = room.cool_to if warm else room.heat_to
        if room.paused or room.temp is None or target is None:
            continue
        past = room.temp - target if warm else target - room.temp
        narrow = room.heat_to is not None and room.heat_to == room.cool_to
        # Only the room the fan is running for is held to the looser "keep
        # going" limits; any other has to earn a start of its own.
        keeping = running and for_room in (None, room.room_id)
        if past <= 0 or (not keeping and past < (NARROW_PAST_F if narrow else PAST_F)):
            continue
        if intake and (outside is None or (outside >= room.temp if warm else outside <= room.temp)):
            # The fan would draw in air that works against the room.
            continue
        gaps = {
            other.room_id: (room.temp - other.temp if warm else other.temp - room.temp)
            for other in rooms
            if other is not room
            and not other.paused
            and other.temp is not None
            # Not one that mixing would push further past its own target.
            and not _past_own(other, warm)
        }
        need = KEEP_SPREAD_F if keeping else SPREAD_F
        helpers = tuple(room_id for room_id, gap in gaps.items() if gap >= need)
        if helpers and (best is None or past > best.past):
            best = Want(
                room.room_id, room.name, helpers, round(past, 2), round(max(gaps.values()), 2)
            )
    return best


def _past_own(room: RoomNow, warm: bool) -> bool:
    """Whether a room is itself at or past its target on the side being worked."""
    assert room.temp is not None
    if warm:
        return room.cool_to is not None and room.temp >= room.cool_to
    return room.heat_to is not None and room.temp <= room.heat_to


def _degrees(delta_f: float, unit: str) -> str:
    """A °F difference in the house's unit, for a note or a log line."""
    return f"{round(delta_f * 5 / 9, 1) if unit == 'C' else round(delta_f, 1)}°{unit}"


@dataclass
class ZoneInput:
    """What the scheduler knows about one zone this minute."""

    thermostat_entity_id: str
    name: str
    level: str
    air_intake: str
    idle: bool
    cycle_mode: str | None
    side: str | None
    obey: bool
    rooms: list[RoomNow]
    fan_mode: str | None
    supported: bool
    # Why nothing may run at all (system off, Vacation Mode, an open door), or "".
    blocked: str = ""
    # The thermostat is answering. One that is not cannot be told anything,
    # so a fan HomeClimate turned on stays remembered until it is back.
    available: bool = True


@dataclass
class _Test:
    started: datetime
    # Each room's reading at the start, so only rooms read at both ends count.
    start: dict[str, float]
    outside: float
    turned_on: bool


@dataclass
class Manager:
    """Decides, once a minute, whether each zone's fan should be running."""

    _ours: set[str] = field(default_factory=set)
    _since: dict[str, datetime] = field(default_factory=dict)
    _runs: dict[str, list[tuple[datetime, datetime]]] = field(default_factory=dict)
    _ran_at: dict[str, datetime] = field(default_factory=dict)
    # The room each running fan was started for.
    _for: dict[str, str] = field(default_factory=dict)
    _met: set[str] = field(default_factory=set)
    _notes: dict[str, str] = field(default_factory=dict)
    _watched: set[str] = field(default_factory=set)
    _tests: dict[str, _Test] = field(default_factory=dict)
    _loaded: bool = False

    async def _load(self, conn: aiosqlite.Connection, now: datetime) -> None:
        if self._loaded:
            return
        try:
            stored = json.loads(await db.get_system_setting(conn, RUNNING_SETTING, "[]"))
        except ValueError:
            stored = []
        self._ours = (
            {t for t in stored if isinstance(t, str)} if isinstance(stored, list) else set()
        )
        # A fan found running after a restart counts from now, so the hourly
        # limit still applies to it.
        self._since = dict.fromkeys(self._ours, now)
        self._loaded = True

    async def _remember(self, conn: aiosqlite.Connection) -> None:
        await db.set_system_setting(conn, RUNNING_SETTING, json.dumps(sorted(self._ours)))

    def running(self, thermostat_entity_id: str) -> bool:
        return thermostat_entity_id in self._ours

    def testing(self, thermostat_entity_id: str) -> bool:
        return thermostat_entity_id in self._tests

    def note(self, thermostat_entity_id: str) -> str:
        return self._notes.get(thermostat_entity_id, "")

    def minutes_used(self, thermostat_entity_id: str, now: datetime) -> int:
        """Minutes the fan has run for this zone in the last hour."""
        start = now - WINDOW
        spans = list(self._runs.get(thermostat_entity_id, []))
        if thermostat_entity_id in self._since:
            spans.append((self._since[thermostat_entity_id], now))
        used = sum(
            (min(end, now) - max(begin, start)).total_seconds()
            for begin, end in spans
            if end > start and begin < now
        )
        return int(used // 60)

    async def _set(self, ha: Any, thermostat_entity_id: str, mode: str) -> bool:
        try:
            await ha.set_thermostat_fan_mode(thermostat_entity_id, mode)
        except Exception:
            log.exception("Could not set the fan of %s to %s", thermostat_entity_id, mode)
            return False
        return True

    async def _stop(
        self, conn: aiosqlite.Connection, ha: Any, zone: ZoneInput, now: datetime
    ) -> bool:
        """Hand a fan HomeClimate turned on back to the thermostat. True if it was ours."""
        tid = zone.thermostat_entity_id
        if tid not in self._ours or not zone.available:
            return False
        # Always sent, whatever Home Assistant last reported: a report that
        # lags behind must never leave a fan running that HomeClimate started.
        if not await self._set(ha, tid, "auto"):
            return False
        self._ours.discard(tid)
        self._for.pop(tid, None)
        began = self._since.pop(tid, None)
        if began is not None:
            runs = self._runs.setdefault(tid, [])
            runs.append((began, now))
            self._runs[tid] = [r for r in runs if r[1] > now - WINDOW]
        await self._remember(conn)
        return True

    def _why_not(self, zone: ZoneInput, now: datetime) -> str | None:
        """Why the fan may not run for this zone; None when it may."""
        tid = zone.thermostat_entity_id
        if zone.level == "off":
            return ""
        if zone.blocked:
            return zone.blocked
        if not zone.supported:
            return "This thermostat has no fan setting HomeClimate can switch"
        if not zone.idle:
            return ""
        if not zone.obey or zone.side not in ("heating", "cooling"):
            return "Only used while the building holds this zone to heating or to cooling"
        ran = self._ran_at.get(tid)
        if ran is not None and timedelta(0) <= now - ran < AFTER_RUN:
            left = math.ceil((AFTER_RUN - (now - ran)).total_seconds() / 60)
            return f"Waiting {left} min after the last run"
        if self.minutes_used(tid, now) >= CAP.total_seconds() // 60:
            return "Has run 30 minutes in the last hour"
        return None

    async def release(self, conn: aiosqlite.Connection, ha: Any, now: datetime) -> None:
        """Hand every fan HomeClimate has on back to its thermostat.

        For when the zones cannot be read at all: a fan must not be left
        running because the code that would stop it could not run.
        """
        await self._load(conn, now)
        for tid in sorted(self._ours):
            if await self._set(ha, tid, "auto"):
                self._ours.discard(tid)
                self._for.pop(tid, None)
                began = self._since.pop(tid, None)
                if began is not None:
                    self._runs.setdefault(tid, []).append((began, now))
        self._tests.clear()
        await self._remember(conn)

    async def forget(self, conn: aiosqlite.Connection) -> None:
        """Drop every fan from the books without sending anything.

        For leaving Developer Mode: what was "turned on" there was only
        logged, so there is nothing to hand back, and a fan somebody has on
        for real must not be turned off on the strength of it.
        """
        self._ours.clear()
        self._since.clear()
        self._for.clear()
        self._tests.clear()
        self._loaded = True
        await self._remember(conn)

    async def tick(
        self,
        conn: aiosqlite.Connection,
        ha: Any,
        zones: list[ZoneInput],
        outside: float | None,
        now: datetime,
        *,
        say: Callable[[str, dict], Awaitable[None]],
        open_vents: Callable[[list[str]], Awaitable[None]],
        unit: str = "F",
    ) -> None:
        await self._load(conn, now)
        seen = {z.thermostat_entity_id for z in zones}
        for gone in sorted(self._ours - seen):
            # Its zone has no engine any more (deleted, or emptied of rooms):
            # hand the fan back before forgetting it, and keep trying if that fails.
            if await self._set(ha, gone, "auto"):
                self._ours.discard(gone)
                self._since.pop(gone, None)
                await self._remember(conn)
        for gone in set(self._tests) - seen:
            del self._tests[gone]
        for zone in zones:
            try:
                await self._tick_zone(conn, ha, zone, outside, now, say, open_vents, unit)
            except Exception:
                # One zone's trouble must not leave another's fan unattended.
                log.exception("Could not run the fan for %s", zone.thermostat_entity_id)

    async def _tick_zone(
        self,
        conn: aiosqlite.Connection,
        ha: Any,
        zone: ZoneInput,
        outside: float | None,
        now: datetime,
        say: Callable[[str, dict], Awaitable[None]],
        open_vents: Callable[[list[str]], Awaitable[None]],
        unit: str,
    ) -> None:
        tid = zone.thermostat_entity_id
        if zone.cycle_mode is not None or tid not in self._met:
            # Also the first time a zone is seen after a start: a cooling run
            # may have ended just before it, and nothing here remembers.
            self._met.add(tid)
            self._ran_at[tid] = now
        if tid in self._tests:
            await self._tick_test(conn, ha, zone, now, say)
            return
        why_not = self._why_not(zone, now)
        want = None
        if why_not is None:
            passive = "cooling" if zone.side == "heating" else "heating"
            want = decide(
                zone.rooms,
                passive,
                running=tid in self._ours,
                intake=zone.air_intake == "yes",
                outside=outside,
                for_room=self._for.get(tid),
            )
        self._notes[tid] = why_not or ""
        if (want is None or zone.level != "on") and await self._stop(conn, ha, zone, now):
            await say(f"Fan stopped for {zone.name}", {"thermostat": tid})
        if want is None:
            self._watched.discard(tid)
            return
        what = (
            f"{want.room_name} is {_degrees(want.past, unit)} past its target and another"
            f" room is {_degrees(want.spread, unit)} closer to it"
        )
        details = {"thermostat": tid, "room": want.room_id, "past": want.past}
        if zone.level == "watch":
            self._notes[tid] = f"Would run: {what}"
            if tid not in self._watched:
                self._watched.add(tid)
                await say(f"Fan would run for {zone.name} (watching only): {what}", details)
            return
        self._notes[tid] = f"Running: {what}"
        if tid in self._ours:
            self._for[tid] = want.room_id
            return
        if zone.fan_mode == "on":
            self._notes[tid] = "The fan is already on at the thermostat"
            return
        if not await self._set(ha, tid, "on"):
            self._notes[tid] = "The thermostat did not accept the fan change"
            return
        self._ours.add(tid)
        self._since[tid] = now
        self._for[tid] = want.room_id
        await self._remember(conn)
        await open_vents([want.room_id, *want.helpers])
        await say(f"Fan running for {zone.name}: {what}", details)

    async def start_test(
        self,
        conn: aiosqlite.Connection,
        ha: Any,
        zone: ZoneInput | None,
        outside: float | None,
        now: datetime,
    ) -> None:
        if zone is None:
            raise FanError(ZONE_UNKNOWN)
        tid = zone.thermostat_entity_id
        if tid in self._tests:
            raise FanError(TEST_RUNNING)
        if not zone.supported:
            raise FanError(NO_FAN_SETTING)
        if zone.blocked:
            raise FanError(TEST_BLOCKED)
        await self._load(conn, now)
        if not zone.idle or tid in self._ours:
            raise FanError(TEST_BUSY)
        start = {r.room_id: r.temp for r in zone.rooms if r.temp is not None}
        if not start or outside is None:
            raise FanError(TEST_NO_OUTSIDE)
        inside = sum(start.values()) / len(start)
        if abs(inside - outside) < TEST_MIN_DIFFERENCE_F:
            raise FanError(TEST_TOO_CLOSE)
        turned_on = zone.fan_mode != "on"
        if turned_on:
            if not await self._set(ha, tid, "on"):
                raise FanError(FAN_FAILED)
            # Remembered like any fan HomeClimate turned on, so a restart in
            # the middle of the test hands it back.
            self._ours.add(tid)
            # Timed like any run, so a fan that cannot be handed back at the
            # end is still under the hourly limit.
            self._since[tid] = now
            await self._remember(conn)
        self._tests[tid] = _Test(now, start, outside, turned_on)

    async def _tick_test(
        self,
        conn: aiosqlite.Connection,
        ha: Any,
        zone: ZoneInput,
        now: datetime,
        say: Callable[[str, dict], Awaitable[None]],
    ) -> None:
        tid = zone.thermostat_entity_id
        test = self._tests[tid]
        # Only rooms read at both ends: one whose sensor dropped out would
        # otherwise look like the zone moving.
        ends = {r.room_id: r.temp for r in zone.rooms if r.temp is not None}
        both = sorted(set(test.start) & set(ends))
        interrupted = not zone.idle or bool(zone.blocked) or not both
        if not interrupted and timedelta(0) <= now - test.started < TEST_LENGTH:
            self._notes[tid] = "Testing for an outside air intake"
            return
        del self._tests[tid]
        if test.turned_on and await self._stop(conn, ha, zone, now):
            # Handed back: a test is asked for, so it is not counted against
            # the hourly limit.
            self._runs[tid].pop()
        result: dict[str, Any] = {"at": now.isoformat(), "interrupted": interrupted}
        if not interrupted:
            began = sum(test.start[r] for r in both) / len(both)
            ended = sum(ends[r] for r in both) / len(both)
            toward = 1.0 if test.outside > began else -1.0
            moved = round((ended - began) * toward, 2)
            result.update(
                difference=round(abs(began - test.outside), 1),
                moved=moved,
                hint="possible" if moved >= TEST_MOVED_F else "none",
            )
        await db.set_system_setting(conn, TEST_SETTING + tid, json.dumps(result))
        self._notes[tid] = ""
        await say(f"Fan test finished for {zone.name}", {"thermostat": tid, **result})


async def last_test(conn: aiosqlite.Connection, thermostat_entity_id: str) -> dict | None:
    """The last intake test's result for a zone, or None if it never ran."""
    try:
        found = json.loads(
            await db.get_system_setting(conn, TEST_SETTING + thermostat_entity_id, "")
        )
    except ValueError:
        return None
    return found if isinstance(found, dict) else None
