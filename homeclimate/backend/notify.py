"""Notifications: chosen events, sent through a Home Assistant notify service.

HomeClimate already writes everything worth knowing to its log. This turns
the parts you choose into notifications: warnings and errors from the
categories you pick, and an optional daily summary. It sends messages and
nothing else.

- Each message is sent once: the same text is not sent again for six hours.
- No more than six in an hour, so a bad night cannot flood a phone; when the
  limit is hit, one last message says more are in the log.
- Nothing is sent while Dev Mode is on unless that is switched on too.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import db, tz
from .user_errors import UserError, fixed

log = logging.getLogger(__name__)

SETTING_PREFIX = "notify_"
# What can be chosen, with the words the Settings section shows for each.
CATEGORIES: dict[str, str] = {
    "engine": "Heating and cooling (safety limits, stuck cycles, sensors)",
    "reconcile": "Something outside HomeClimate changed a vent or a thermostat",
    "fireplace": "Fireplace",
    "forecast": "Weather forecast",
    "auth": "Sign-in problems",
    "system": "HomeClimate itself",
}
LEVELS = ("warning", "error")
DEFAULT_CATEGORIES = ("engine", "fireplace")
REPEAT_AFTER = timedelta(hours=6)
MAX_AN_HOUR = 6
MAX_LEN = 240
SEND_TIMEOUT_S = 10
SUMMARY_TRIES = 3
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_SERVICE = re.compile(r"^notify\.[a-z0-9_]+$")


class NotifyError(UserError):
    """A notification setting that cannot be used."""


UNKNOWN_SETTING = fixed("Unknown notification setting")
BAD_BOOL = fixed("enabled, daily_summary and in_dev_mode must be true or false")
BAD_SERVICE = fixed("service must be a notify service such as notify.mobile_app_my_phone, or empty")
BAD_LEVEL = fixed("level must be warning or error")
BAD_CATEGORIES = fixed("categories must be a list of known categories")
BAD_HOUR = fixed("summary_hour must be a whole hour from 0 to 23")
NO_SERVICE = fixed("Choose a notify service first")
NOT_CONNECTED = fixed("Home Assistant is not connected, so nothing can be sent right now")
SEND_FAILED = fixed("Home Assistant did not accept the notification. Check the service name.")

BOOLS = ("enabled", "daily_summary", "in_dev_mode")


def _parse(name: str, value: Any) -> str:
    if name in BOOLS:
        if not isinstance(value, bool):
            raise NotifyError(BAD_BOOL)
        return "1" if value else "0"
    if name == "service":
        if value in (None, ""):
            return ""
        if (
            not isinstance(value, str)
            or len(value) > 120
            or not _SERVICE.match(value)
            # The action for notify entities needs a target this does not send.
            or value == "notify.send_message"
        ):
            raise NotifyError(BAD_SERVICE)
        return value
    if name == "level":
        if value not in LEVELS:
            raise NotifyError(BAD_LEVEL)
        return str(value)
    if name == "categories":
        if not isinstance(value, list) or any(
            not isinstance(c, str) or c not in CATEGORIES for c in value
        ):
            raise NotifyError(BAD_CATEGORIES)
        return ",".join(c for c in CATEGORIES if c in value)
    if name == "summary_hour":
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 23:
            raise NotifyError(BAD_HOUR)
        return str(value)
    raise NotifyError(UNKNOWN_SETTING)


async def get_settings(conn: aiosqlite.Connection) -> dict[str, Any]:
    async def raw(name: str, default: str) -> str:
        return str(await db.get_system_setting(conn, SETTING_PREFIX + name, default))

    chosen = (await raw("categories", ",".join(DEFAULT_CATEGORIES))).split(",")
    hour = await raw("summary_hour", "7")
    return {
        "enabled": await raw("enabled", "0") == "1",
        "service": await raw("service", ""),
        "level": await raw("level", "warning"),
        "categories": [c for c in CATEGORIES if c in chosen],
        "daily_summary": await raw("daily_summary", "0") == "1",
        "summary_hour": int(hour) if hour.isdigit() and int(hour) <= 23 else 7,
        "in_dev_mode": await raw("in_dev_mode", "0") == "1",
    }


async def update_settings(conn: aiosqlite.Connection, body: dict[str, Any]) -> dict[str, Any]:
    parsed = {name: _parse(name, value) for name, value in body.items()}
    for name, value in parsed.items():
        await db.set_system_setting(conn, SETTING_PREFIX + name, value)
    return await get_settings(conn)


async def summary(conn: aiosqlite.Connection, *, now: datetime) -> str:
    """Yesterday in a sentence or two: what ran, and what went wrong."""
    local_now = tz.to_local(now)
    start_local = (local_now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    start = start_local.astimezone(UTC).replace(tzinfo=None).isoformat()
    end = end_local.astimezone(UTC).replace(tzinfo=None).isoformat()
    # A cycle counts for the part of it that fell inside yesterday: one still
    # running, or one that crossed midnight, is clipped to the day.
    until = now.astimezone(UTC).replace(tzinfo=None).isoformat()
    async with conn.execute(
        "SELECT mode, COUNT(*) AS n,"
        " SUM((julianday(MIN(COALESCE(ended_at, ?), ?)) - julianday(MAX(started_at, ?))) * 1440)"
        " AS minutes FROM cycle_logs"
        " WHERE started_at < ? AND COALESCE(ended_at, ?) > ? GROUP BY mode",
        (until, end, start, end, until, start),
    ) as cur:
        modes = {r["mode"]: (r["n"], r["minutes"] or 0.0) for r in await cur.fetchall()}
    async with conn.execute(
        "SELECT level, COUNT(*) AS n FROM event_log"
        " WHERE timestamp >= ? AND timestamp < ? AND level IN ('warning', 'error') GROUP BY level",
        (start, end),
    ) as cur:
        problems = {r["level"]: r["n"] for r in await cur.fetchall()}

    def ran(mode: str, word: str) -> str | None:
        if mode not in modes:
            return None
        n, minutes = modes[mode]
        hours, mins = divmod(round(minutes), 60)
        length = f"{hours} h {mins} min" if hours else f"{mins} min"
        return f"{word} ran {n} {'time' if n == 1 else 'times'} for {length}"

    parts = [p for p in (ran("heating", "heating"), ran("cooling", "cooling")) if p]
    text = "Yesterday " + (" and ".join(parts) if parts else "nothing ran") + "."
    warnings, errors = problems.get("warning", 0), problems.get("error", 0)
    if warnings or errors:
        counts = []
        if errors:
            counts.append(f"{errors} {'error' if errors == 1 else 'errors'}")
        if warnings:
            counts.append(f"{warnings} {'warning' if warnings == 1 else 'warnings'}")
        text += f" The log has {' and '.join(counts)}."
    else:
        text += " No warnings."
    return text


class Notifier:
    """Decides what to send, and sends it. Never raises into its callers.

    Sending is handed to a task of its own with a time limit, so a slow Home
    Assistant never holds up whatever logged the event.
    """

    def __init__(self) -> None:
        self._sent: dict[str, datetime] = {}
        self._recent: list[datetime] = []
        self._recent_errors: list[datetime] = []
        self._limited = False
        self._summary_day: str | None = None
        self._summary_tries: tuple[str, int] = ("", 0)
        self._summary_busy = False
        self._tasks: set[asyncio.Future] = set()
        self.last_error = False

    async def _deliver(self, ha: Any, service: str, title: str, message: str) -> bool:
        try:
            await asyncio.wait_for(
                ha.call_service(
                    "notify", service.split(".", 1)[1], {"title": title, "message": message}
                ),
                SEND_TIMEOUT_S,
            )
        except Exception:
            log.warning("Could not send a notification through %s", service, exc_info=True)
            self.last_error = True
            return False
        self.last_error = False
        return True

    def _detach(self, coro: Any) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def drain(self) -> None:
        """Wait for anything still being sent (for tests and shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def on_event(
        self,
        conn: aiosqlite.Connection,
        ha: Any,
        *,
        level: str,
        category: str,
        message: str,
        dev_mode: bool,
        now: datetime,
    ) -> bool:
        """Queue a logged event for sending if it is one of those chosen. Returns whether it was."""
        # Most events are neither: decided before anything is read.
        if level not in LEVELS or category not in CATEGORIES:
            return False
        try:
            settings = await get_settings(conn)
            if not settings["enabled"] or not settings["service"]:
                return False
            if dev_mode and not settings["in_dev_mode"]:
                return False
            if category not in settings["categories"]:
                return False
            if settings["level"] == "error" and level != "error":
                return False
            if ha is None or not getattr(ha, "is_connected", True):
                return False
            # The same thing with different numbers in it is the same thing:
            # "deferred 5.0 min", then 4.0, then 3.0, is one message.
            key = _NUMBER.sub("#", message)
            last = self._sent.get(key)
            if last is not None and now - last < REPEAT_AFTER:
                return False
            hour = timedelta(hours=1)
            self._recent = [t for t in self._recent if now - t < hour]
            self._recent_errors = [t for t in self._recent_errors if now - t < hour]
            self._sent = {m: t for m, t in self._sent.items() if now - t < REPEAT_AFTER}
            if not self._recent and not self._recent_errors:
                self._limited = False
            # Errors have an allowance of their own, so a run of warnings can
            # never crowd one out.
            bucket = self._recent_errors if level == "error" else self._recent
            if len(bucket) >= MAX_AN_HOUR:
                if not self._limited:
                    self._limited = True
                    self._detach(
                        self._deliver(
                            ha,
                            settings["service"],
                            "HomeClimate",
                            "More is happening than can be sent. See the log in HomeClimate.",
                        )
                    )
                return False
            self._sent[key] = now
            bucket.append(now)
            title = "HomeClimate" if level == "warning" else "HomeClimate: problem"
            text = message if len(message) <= MAX_LEN else message[: MAX_LEN - 1] + "…"
            service = settings["service"]

            async def send() -> None:
                if not await self._deliver(ha, service, title, text):
                    # Not sent after all: it may be said again, and does not count.
                    self._sent.pop(key, None)
                    # The lists are rebuilt as they are pruned, so look again.
                    current = self._recent_errors if level == "error" else self._recent
                    with contextlib.suppress(ValueError):
                        current.remove(now)

            self._detach(send())
            return True
        except Exception:
            log.exception("Could not handle a notification")
            return False

    async def daily(
        self, conn: aiosqlite.Connection, ha: Any, *, dev_mode: bool, now: datetime
    ) -> bool:
        """Queue yesterday's summary once, at or after the chosen hour. Called every minute."""
        try:
            local = tz.to_local(now)
            today = local.date().isoformat()
            if self._summary_day == today or self._summary_busy:
                return False
            settings = await get_settings(conn)
            if (
                not settings["enabled"]
                or not settings["daily_summary"]
                or not settings["service"]
                or (dev_mode and not settings["in_dev_mode"])
                # At the hour, or later the same day if it was missed.
                or local.hour < settings["summary_hour"]
                or ha is None
                or not getattr(ha, "is_connected", True)
            ):
                return False
            if await db.get_system_setting(conn, SETTING_PREFIX + "summary_sent", "") == today:
                self._summary_day = today
                return False
            day, tries = self._summary_tries
            tries = tries + 1 if day == today else 1
            self._summary_tries = (today, tries)
            if tries > SUMMARY_TRIES:
                self._summary_day = today  # given up for today
                return False
            text = await summary(conn, now=now)
            service = settings["service"]
            self._summary_busy = True

            async def send() -> None:
                try:
                    if await self._deliver(ha, service, "HomeClimate: yesterday", text):
                        self._summary_day = today
                        await db.set_system_setting(conn, SETTING_PREFIX + "summary_sent", today)
                finally:
                    self._summary_busy = False

            self._detach(send())
            return True
        except Exception:
            log.exception("Could not send the daily summary")
            return False

    async def test(self, conn: aiosqlite.Connection, ha: Any) -> None:
        """Send a test message now, whatever else is set. Raises NotifyError if it can't."""
        settings = await get_settings(conn)
        if not settings["service"]:
            raise NotifyError(NO_SERVICE)
        if ha is None or not getattr(ha, "is_connected", True):
            raise NotifyError(NOT_CONNECTED)
        if not await self._deliver(
            ha, settings["service"], "HomeClimate", "This is a test notification from HomeClimate."
        ):
            raise NotifyError(SEND_FAILED)
