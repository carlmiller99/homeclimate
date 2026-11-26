"""The weather forecast: fetched from Home Assistant, kept through outages, archived.

One weather entity for the house. Every 30 minutes the hourly forecast is
fetched with ``weather.get_forecasts`` and stored in °F. If a fetch fails the
last good forecast keeps being used for the hours it still covers. Once an hour
a snapshot of the next 72 hours is archived so forecasts can later be scored
against what happened.

This module only reads. Nothing here changes how the home is controlled.
"""

from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import building_mode, db, house, tz
from .units import to_f
from .user_errors import UserError, fixed

log = logging.getLogger(__name__)

REFRESH_EVERY_MIN = 30
# A forecast older than this is "kept": still used, but shown as not current.
FRESH_FOR = timedelta(minutes=90)
SNAPSHOT_HOURS = 72
SNAPSHOT_KEEP_DAYS = 90
PAST_KEEP = timedelta(days=2)
TEMP_SCALE = 100

SETTING_PREFIX = "forecast_"
# name -> kind, default
SETTINGS: dict[str, tuple[str, Any]] = {
    "enabled": ("bool", False),
    "weather_entity": ("entity", ""),
    # Add each hour's usual error to the forecast once enough has been seen.
    "correct": ("bool", True),
}
SHADES_WEATHER_SETTING = "shades_weather_entity"


class ForecastError(UserError):
    """A request the caller can fix; the message is one of the constants below."""


UNKNOWN_SETTING = fixed("Unknown forecast setting")
BAD_ENABLED = fixed("enabled and correct must be true or false")
BAD_ENTITY = fixed("weather_entity must be a weather entity or empty")
FETCH_FAILED = "Home Assistant did not return an hourly forecast from this weather entity."


def parse_setting(name: str, value: Any) -> Any:
    if name not in SETTINGS:
        raise ForecastError(UNKNOWN_SETTING)
    if SETTINGS[name][0] == "bool":
        if not isinstance(value, bool):
            raise ForecastError(BAD_ENABLED)
        return value
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or not value.startswith("weather."):
        raise ForecastError(BAD_ENTITY)
    return value


async def get_settings(conn: aiosqlite.Connection) -> dict[str, Any]:
    enabled = await db.get_system_setting(conn, SETTING_PREFIX + "enabled", "0")
    entity = await db.get_system_setting(conn, SETTING_PREFIX + "weather_entity", "")
    correct = await db.get_system_setting(conn, SETTING_PREFIX + "correct", "1")
    return {"enabled": enabled == "1", "weather_entity": entity, "correct": correct == "1"}


async def update_settings(conn: aiosqlite.Connection, body: dict[str, Any]) -> dict[str, Any]:
    parsed = {name: parse_setting(name, value) for name, value in body.items()}
    for name, value in parsed.items():
        encoded = ("1" if value else "0") if isinstance(value, bool) else value
        await db.set_system_setting(conn, SETTING_PREFIX + name, encoded)
    return await get_settings(conn)


async def weather_entity(conn: aiosqlite.Connection) -> str:
    """The house's weather entity: the one set here, else the one Shades uses."""
    own = await db.get_system_setting(conn, SETTING_PREFIX + "weather_entity", "")
    return own or await db.get_system_setting(conn, SHADES_WEATHER_SETTING, "")


@dataclass(frozen=True)
class Hour:
    """One forecast hour. ``temp`` is °F; the percentages may be unknown."""

    at: datetime
    temp: float
    cloud_pct: int | None
    precip_pct: int | None
    condition: str


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value)


def _pct(value: Any) -> int | None:
    n = _number(value)
    return None if n is None or not 0 <= n <= 100 else round(n)


def parse_hourly(raw: Any, unit: str) -> list[Hour]:
    """Home Assistant's forecast entries as hours in °F, oldest first.

    ``unit`` is the weather entity's ``temperature_unit``. Entries without a
    usable time or temperature are skipped.
    """
    scale = "C" if "C" in unit.upper() else "F"
    hours: dict[datetime, Hour] = {}
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            continue
        temp = _number(entry.get("temperature"))
        try:
            at = datetime.fromisoformat(str(entry.get("datetime")))
        except ValueError:
            continue
        if temp is None or at.tzinfo is None:
            continue
        at = at.astimezone(UTC).replace(second=0, microsecond=0)
        hours[at] = Hour(
            at=at,
            temp=to_f(temp, scale),
            cloud_pct=_pct(entry.get("cloud_coverage")),
            precip_pct=_pct(entry.get("precipitation_probability")),
            condition=str(entry.get("condition") or ""),
        )
    return [hours[at] for at in sorted(hours)]


SOURCE_SETTING = SETTING_PREFIX + "source"


async def save(
    conn: aiosqlite.Connection, hours: list[Hour], *, now: datetime, source: str = ""
) -> None:
    """Store a fetched forecast over the hours it covers, and archive a snapshot.

    Hours it does not cover are left alone, so a short reply cannot wipe a
    longer forecast. A forecast from a different weather entity replaces
    everything: one source's hours are never shown as another's.
    """
    fetched = int(now.timestamp())
    rows = [
        (
            int(h.at.timestamp()),
            round(h.temp * TEMP_SCALE),
            h.cloud_pct,
            h.precip_pct,
            h.condition,
            fetched,
        )
        for h in hours
    ]
    issued = fetched - fetched % 3600
    archive = [
        (issued, at, temp) for at, temp, *_rest in rows if 0 <= at - issued < SNAPSHOT_HOURS * 3600
    ]
    if await db.get_system_setting(conn, SOURCE_SETTING, "") != source:
        await conn.execute("DELETE FROM forecast_hours")
        # Another source is off by its own amounts: what was learned about
        # the old one, and its archive, do not carry over.
        await conn.execute("DELETE FROM forecast_snapshots")
        await conn.execute("DELETE FROM forecast_bias")
    await conn.execute(
        "DELETE FROM forecast_hours WHERE (at BETWEEN ? AND ?) OR at < ?",
        (rows[0][0], rows[-1][0], int((now - PAST_KEEP).timestamp())),
    )
    await conn.executemany(
        "INSERT OR REPLACE INTO forecast_hours(at, temp, cloud_pct, precip_pct, condition,"
        " fetched_at) VALUES(?,?,?,?,?,?)",
        rows,
    )
    # One archived snapshot per clock hour: what was forecast, as of when.
    await conn.executemany(
        "INSERT OR IGNORE INTO forecast_snapshots(issued, at, temp) VALUES(?,?,?)", archive
    )
    await conn.execute(
        "DELETE FROM forecast_snapshots WHERE issued < ?",
        (int((now - timedelta(days=SNAPSHOT_KEEP_DAYS)).timestamp()),),
    )
    # set_system_setting commits, taking the statements above with it.
    await db.set_system_setting(conn, SOURCE_SETTING, source)
    await conn.commit()


async def load(conn: aiosqlite.Connection, *, now: datetime) -> tuple[list[Hour], datetime | None]:
    """The stored forecast from the current hour on, and when it was fetched."""
    start = now.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    async with conn.execute(
        "SELECT * FROM forecast_hours WHERE at >= ? ORDER BY at", (int(start.timestamp()),)
    ) as cur:
        rows = list(await cur.fetchall())
    hours = [
        Hour(
            at=datetime.fromtimestamp(r["at"], UTC),
            temp=r["temp"] / TEMP_SCALE,
            cloud_pct=r["cloud_pct"],
            precip_pct=r["precip_pct"],
            condition=r["condition"],
        )
        for r in rows
    ]
    fetched = max((r["fetched_at"] for r in rows), default=None)
    return hours, None if fetched is None else datetime.fromtimestamp(fetched, UTC)


class Forecast:
    """Fetches the forecast and remembers how the last attempt went."""

    def __init__(self) -> None:
        self.failed = False
        self.last_attempt: datetime | None = None
        self._lock = asyncio.Lock()

    async def refresh(self, conn: aiosqlite.Connection, ha: Any, *, now: datetime) -> str | None:
        """Fetch and store the forecast.

        Returns "fetched" or "failed" when that differs from the attempt
        before, so the caller can log changes without logging every run.
        """
        async with self._lock:
            return await self._refresh(conn, ha, now)

    async def _refresh(self, conn: aiosqlite.Connection, ha: Any, now: datetime) -> str | None:
        settings = await get_settings(conn)
        entity = await weather_entity(conn)
        if not settings["enabled"] or not entity:
            self.failed = False
            return None
        if not ha.is_connected:
            # Not the weather source's fault; the next run will ask.
            return None
        self.last_attempt = now
        try:
            raw = await ha.get_forecasts(entity, "hourly")
            unit = ((ha.get_state(entity) or {}).get("attributes") or {}).get("temperature_unit")
            hours = parse_hourly(raw, str(unit or f"°{ha.ha_temp_unit}"))
            if not hours:
                raise ValueError("no usable hours")
            await save(conn, hours, now=now, source=entity)
        except Exception:
            log.warning("Could not fetch the forecast from %s", entity, exc_info=True)
            changed = not self.failed
            self.failed = True
            return "failed" if changed else None
        changed = self.failed
        self.failed = False
        return "fetched" if changed else None

    async def snapshot(
        self, conn: aiosqlite.Connection, *, now: datetime, bias: Any = None
    ) -> dict[str, Any]:
        """Everything the Forecasts section shows.

        ``bias`` (a ``forecast_bias.Bias``) corrects the temperatures shown when
        the Correct setting is on; ``temp_raw`` is always what the source gave.
        """
        settings = await get_settings(conn)
        entity = await weather_entity(conn)
        hours, fetched = await load(conn, now=now)
        if not settings["enabled"]:
            state = "off"
        elif not entity:
            state = "no_entity"
        elif not hours:
            state = "none"
        elif self.failed or fetched is None or now - fetched > FRESH_FOR:
            state = "kept"
        else:
            state = "fresh"
        if state not in ("off", "no_entity") and (
            await db.get_system_setting(conn, SOURCE_SETTING, "") != entity
        ):
            # What is stored came from a different weather entity: not this one's forecast.
            hours, state = [], "none"
        if state in ("off", "no_entity"):
            hours = []
        raw = {h.at: h.temp for h in hours}
        if bias is not None and settings["correct"]:
            hours = bias.correct(hours)
        # What each hour asks of the house, by the same rule as Today's Plan:
        # colder outside than the lowest heating target needs heat, warmer
        # than the highest cooling target needs cooling.
        band = (await house.load(conn)).outer_band()
        heat_below = band.heat_to if band else building_mode.DEFAULT_HEAT_BELOW_F
        cool_above = band.cool_to if band else building_mode.DEFAULT_COOL_ABOVE_F

        def need(temp: float) -> str:
            return "heat" if temp < heat_below else "cool" if temp > cool_above else "coast"

        def runs(found: list[Hour]) -> list[dict[str, Any]]:
            """Consecutive forecast hours asking for the same thing, each with
            the instant it starts: a source need not report every hour."""
            out: list[dict[str, Any]] = []
            for h in found:
                kind = need(h.temp)
                if out and out[-1]["need"] == kind:
                    out[-1]["hours"] += 1
                else:
                    out.append({"need": kind, "at": h.at.isoformat(), "hours": 1})
            return out

        def sky(found: list[Hour]) -> str:
            seen = [h.condition for h in found if h.condition]
            return max(set(seen), key=lambda c: (seen.count(c), -seen.index(c))) if seen else ""

        days: dict[str, list[Hour]] = {}
        for h in hours:
            days.setdefault(tz.to_local(h.at).date().isoformat(), []).append(h)
        return {
            "settings": settings,
            "weather_entity": entity,
            "shared_with_shades": bool(entity) and not settings["weather_entity"],
            "state": state,
            "problem": FETCH_FAILED if self.failed and state in ("kept", "none") else None,
            "fetched_at": fetched.isoformat() if fetched and hours else None,
            "covers_until": hours[-1].at.isoformat() if hours else None,
            "days": [
                {
                    "date": day,
                    "starts_at": found[0].at.isoformat(),
                    "high": max(h.temp for h in found),
                    "low": min(h.temp for h in found),
                    "hours": len(found),
                    "runs": runs(found),
                    "condition": sky(found),
                }
                for day, found in list(days.items())[:3]
            ],
            "hours": [
                {
                    "at": h.at.isoformat(),
                    "temp": h.temp,
                    "temp_raw": raw[h.at],
                    "cloud_pct": h.cloud_pct,
                    "precip_pct": h.precip_pct,
                    "condition": h.condition,
                }
                for h in hours[:24]
            ],
        }
