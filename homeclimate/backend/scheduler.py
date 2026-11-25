"""
Central scheduler.

- Runs a 60-second tick for every thermostat zone's CycleEngine
- Listens to HA state changes and triggers targeted ticks
- Manages the mapping of thermostats → CycleEngine instances
- Owns the system_enabled flag (persisted to DB)
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
from collections.abc import Callable, Coroutine
from datetime import UTC, datetime, timedelta

import aiosqlite
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from . import (
    building_mode,
    db,
    fireplace,
    forecast,
    forecast_bias,
    heat_pump,
    house,
    learning,
    notify,
    openings,
    room_model,
    shades,
    tz,
    zone_balance,
    zones,
)
from .engine import room_manager
from .engine.cycle_engine import SENSOR_STALE_AFTER_MIN, CycleEngine
from .engine.room_manager import get_active_rooms
from .engine.vent_controller import VentController
from .event_logger import EventLogger
from .ha_client import HAClient
from .models import PresenceHoldoverState, ThermostatConfig

log = logging.getLogger(__name__)

BroadcastFn = Callable[[str, dict], Coroutine]

# A single engine tick is retried a few times before giving up, so a transient
# failure — most likely `sqlite3.OperationalError: database is locked` while the
# MCP server briefly holds a write lock on the shared DB file — doesn't silently
# drop a whole 60s control cycle for the zone. (Issue #286)
_TICK_MAX_ATTEMPTS = 3
_TICK_RETRY_BACKOFF_S = 0.2

# Vacation states (Issue #728). Derived from the persisted keys, never stored.
VACATION_OFF = "off"
VACATION_SCHEDULED = "scheduled"
VACATION_ACTIVE = "active"

# A scheduled start that lands later than this (HomeClimate was down at the start
# time) is logged as "started late".
_VACATION_LATE_START_S = 120


VACATION_START_LOCKED = "vacation mode is already active, so its start cannot be changed"


class VacationConflict(Exception):
    """A vacation request that contradicts the current state (HTTP 409).

    The route answers with the matching module constant (``VACATION_START_LOCKED``),
    never with ``str(exc)``: exception text must not reach an API response even
    when it happens to be safe today (CWE-209, code scanning alert #4).
    """


def _iso_or_none(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _parse_instant(value: str) -> datetime | None:
    """A persisted ISO instant as an aware UTC datetime, or None when empty
    or unreadable (a hand-edited DB must not crash startup)."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        log.warning("Ignoring unreadable vacation timestamp %r", value)
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _parse_json_dict(value: str) -> dict:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except ValueError:
        log.warning("Ignoring unreadable vacation setting %r", value)
        return {}
    return parsed if isinstance(parsed, dict) else {}


class Scheduler:
    def __init__(
        self,
        ha: HAClient,
        db_path: str,
        broadcast: BroadcastFn | None = None,
        event_logger: EventLogger | None = None,
    ) -> None:
        self._ha = ha
        self._db_path = db_path
        self._broadcast = broadcast
        self._event_logger = event_logger
        self._notifier = notify.Notifier()
        if event_logger is not None:
            event_logger.set_listener(self._on_logged_event)
        self._vent_ctrl: VentController | None = None
        self._engines: dict[str, CycleEngine] = {}
        # Serializes _sync_engines against concurrent invocation (#434).
        self._sync_engines_lock = asyncio.Lock()
        self._apscheduler = AsyncIOScheduler()
        self._db_conn: aiosqlite.Connection = None  # type: ignore[assignment]
        self._system_enabled: bool = True
        # MCP HTTP server toggle (settings-cog control). Off by default: it is
        # opt-in because the MCP port exposes the full write surface.
        self._mcp_enabled: bool = False
        # MQTT bridge runtime toggle (Issue #519) — the twin of _mcp_enabled.
        self._mqtt_enabled: bool = False
        self._dev_mode: bool = False
        # UI theme preference ("light" | "dark" | "system"). Pure display
        # setting — the engine never reads it.
        self._theme: str = "system"
        self._active_unit: str = "F"
        self._unit_override: str = ""  # non-empty when locked by env var / config
        self._vacation_mode: bool = False
        self._vacation_return_at: datetime | None = None
        # Scheduled start (Issue #728): set only while a trip is SCHEDULED,
        # cleared when it activates, so scheduled and active never overlap.
        self._vacation_start_at: datetime | None = None
        # Welcome home (#728): thermostat_entity_id → {"fired_at", "until"}.
        # A thermostat in here has left vacation early for its welcome-home
        # presence tick. Cleared when the next trip activates.
        self._welcome_fired: dict[str, dict[str, str]] = {}
        # A trip whose whole window passed while HomeClimate was down (#728):
        # {"start_at", "return_at"} until the user dismisses it.
        self._vacation_missed: dict[str, str] = {}
        # Every vacation transition (API, tick, MQTT) runs under this lock, so
        # a cancel racing the tick's activation cannot interleave its DB writes
        # and engine resets with the other's (#728 §4.4).
        self._vacation_lock = asyncio.Lock()
        # Eco Suspend (Issue #500): thermostat_entity_id → resume_at (UTC).
        # Loaded from the eco_suspensions table; swept every tick.
        self._eco_suspends: dict[str, datetime] = {}
        # Strong references to fire-and-forget background tasks. The event loop
        # only holds weak references, so without this a task can be
        # garbage-collected mid-await and silently never finish (Issue #304).
        self._bg_tasks: set[asyncio.Task] = set()
        # Door and window pausing (Smart Control). Timers live in memory.
        self._openings = openings.OpeningMonitor()
        # Heat pump protection: guards per heat pump zone, refreshed each tick
        # and after a zone edit; backup-heat episodes from equipment sources.
        self._heat_pumps: dict[str, heat_pump.HeatPumpGuards] = {}
        self._zone_profiles: dict[str, zones.ZoneProfile] = {}
        # Zone Balance: each zone's balancing call and whether it is obeyed.
        self._balance_calls: dict[str, tuple[zone_balance.Call, bool]] = {}
        self._balance_said: dict[str, tuple[str, bool]] = {}
        self._aux = heat_pump.AuxMonitor()
        self._shades = shades.ShadeController()
        self._forecast = forecast.Forecast()
        self._fireplaces = fireplace.FireplaceMonitor()
        self._calendars = house.CalendarWatch()
        self._building_plan = building_mode.Planner()

    def _spawn_bg(self, coro: Coroutine) -> asyncio.Task:
        """Create a background task and keep a strong reference until it
        completes, so it cannot be garbage-collected while still running."""
        task = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)
        return task

    # ------------------------------------------------------------------
    # Startup / shutdown
    # ------------------------------------------------------------------

    async def start(self) -> None:
        self._db_conn = await aiosqlite.connect(self._db_path)
        self._db_conn.row_factory = aiosqlite.Row
        room_renames = await db.init_db(self._db_conn)

        # Load persisted flags
        val = await db.get_system_setting(self._db_conn, "system_enabled", "1")
        self._system_enabled = val == "1"
        dev_val = await db.get_system_setting(self._db_conn, "developer_mode", "0")
        self._dev_mode = dev_val == "1"
        mcp_val = await db.get_system_setting(self._db_conn, "mcp_enabled", "0")
        self._mcp_enabled = mcp_val == "1"
        mqtt_val = await db.get_system_setting(self._db_conn, "mqtt_enabled", "0")
        self._mqtt_enabled = mqtt_val == "1"
        self._theme = await db.get_system_setting(self._db_conn, "theme", "system")
        await self._load_vacation_state()
        self._eco_suspends = await db.get_all_eco_suspensions(self._db_conn)

        # Temperature unit: env var / add-on config wins; otherwise restore last-known
        self._unit_override = os.environ.get("TEMPERATURE_UNIT", "").upper()
        if self._unit_override in ("F", "C"):
            self._active_unit = self._unit_override
            await db.set_system_setting(self._db_conn, "temperature_unit", self._active_unit)
        else:
            self._active_unit = await db.get_system_setting(self._db_conn, "temperature_unit", "F")
            # Resolve the real unit from HA once it connects and overwrite the DB.
            self._spawn_bg(self._startup_resolve_unit())

        # Wire logger's DB connection
        if self._event_logger:
            self._event_logger.set_conn(self._db_conn)
            await self._event_logger.log(
                "info",
                "system",
                f"Scheduler started (system {'enabled' if self._system_enabled else 'disabled'}"
                f"{', dev mode ON' if self._dev_mode else ''})",
            )
            # Room names must be unique once sanitised for MQTT topics (#519).
            # An upgrade repairs legacy collisions automatically; surface each
            # rename in the Live Feed so it is traceable, never silent.
            for old, new in room_renames:
                await self._event_logger.log(
                    "warning",
                    "system",
                    f"Renamed room '{old}' to '{new}' — room names must be unique",
                    {"old_name": old, "new_name": new, "reason": "sanitized_name_collision"},
                )

        # Wire dev_mode into HA client
        self._ha.dev_mode = self._dev_mode
        self._ha.set_dev_logger(self._event_logger)

        self._vent_ctrl = VentController(self._ha, event_logger=self._event_logger)

        await self._sync_engines()
        await self._load_heat_pumps()
        await self.adopt_zone_contacts()
        await self.adopt_first_build_readings()
        # Learn which door and window sensors to watch before events arrive.
        await self._evaluate_openings()
        await self._evaluate_fireplaces()

        # Subscribe to ALL HA state changes
        self._ha.subscribe_all(self._on_state_change)

        self._apscheduler.add_job(
            self._tick_all,
            "interval",
            seconds=60,
            id="main_tick",
            max_instances=1,
            coalesce=True,
        )
        self._apscheduler.add_job(
            self._purge_old_logs,
            "interval",
            hours=24,
            id="log_purge",
            max_instances=1,
            coalesce=True,
        )
        # Smart Learning: sample every room, running or idle. Read-only.
        self._apscheduler.add_job(
            self._sample_rooms,
            "cron",
            minute=f"*/{learning.SAMPLE_EVERY_MIN}",
            id="room_sampler",
            max_instances=1,
            coalesce=True,
        )
        # The weather forecast: fetched and archived. Read-only.
        self._apscheduler.add_job(
            self.refresh_forecast,
            "interval",
            minutes=forecast.REFRESH_EVERY_MIN,
            id="forecast_refresh",
            # Soon after start-up, once Home Assistant has had time to connect.
            next_run_time=datetime.now(UTC) + timedelta(minutes=2),
            max_instances=1,
            coalesce=True,
        )
        # Self-disable expired ("temporary") schedules (Issue #359). Separate
        # from the engine tick — disabling is a DB write, not a control
        # decision. Runs every minute; finishes any in-progress block first.
        self._apscheduler.add_job(
            self._sweep_expired_schedules,
            "interval",
            seconds=60,
            id="schedule_expiry_sweep",
            max_instances=1,
            coalesce=True,
        )
        # Smart Learning: fit each room's model from its readings, at 3:20 AM
        # house time. Read-only: nothing is commanded from it.
        self._apscheduler.add_job(
            self.fit_room_models,
            "cron",
            hour=3,
            minute=20,
            id="room_model_fit",
            max_instances=1,
            coalesce=True,
        )
        # Daily metrics rollup at 00:05 local — recomputes yesterday + today so
        # cycles that crossed midnight or arrived late are picked up. (#85 1d)
        self._apscheduler.add_job(
            self._rollup_daily_metrics_job,
            "cron",
            hour=0,
            minute=5,
            id="daily_metrics_rollup",
            max_instances=1,
            coalesce=True,
        )
        # Monthly metrics rollup at 00:10 local on the 1st — recomputes the
        # previous month and the current month-to-date. (#85 1e)
        self._apscheduler.add_job(
            self._rollup_monthly_metrics_job,
            "cron",
            day=1,
            hour=0,
            minute=10,
            id="monthly_metrics_rollup",
            max_instances=1,
            coalesce=True,
        )
        self._apscheduler.start()

        # Run purge immediately on startup to clean up before the first tick.
        await self._purge_old_logs()

        log.info("Scheduler started (system_enabled=%s)", self._system_enabled)

    async def stop(self) -> None:
        self._apscheduler.shutdown(wait=False)
        # Cancel any still-pending background tasks before closing the DB they
        # may be using (Issue #304).
        for task in list(self._bg_tasks):
            task.cancel()
        if self._db_conn:
            await self._db_conn.close()
        log.info("Scheduler stopped")

    async def reload_db(self) -> None:
        """Close and reopen the DB connection (e.g. after a restore), then
        rebuild engines from the new data. APScheduler keeps running.

        Engines are torn down BEFORE the swap and rebuilt from scratch after
        it (#430). Surviving engines used to keep in-memory cycles pointing at
        rows that don't exist in the restored DB — temp-sample and room-state
        writes hit FK failures silently, close_cycle_log updated zero rows so
        the running cycle's history vanished, and open cycles INSIDE the
        backup were never adopted. Aborting against the OLD connection closes
        the current cycles coherently; the rebuild then runs restore_from_db
        against the restored data, adopting or discarding its open cycles
        through the normal, tested restore logic.
        """
        if self._db_conn:
            for tid, engine in list(self._engines.items()):
                try:
                    await engine.force_abort(self._db_conn, reason="database restored")
                except Exception:
                    log.exception("reload_db: failed to abort engine for %s", tid)
            self._engines.clear()
            await self._db_conn.close()
        self._db_conn = await aiosqlite.connect(self._db_path)
        self._db_conn.row_factory = aiosqlite.Row
        await db.init_db(self._db_conn)
        if self._event_logger:
            self._event_logger.set_conn(self._db_conn)
        val = await db.get_system_setting(self._db_conn, "system_enabled", "1")
        self._system_enabled = val == "1"
        dev_val = await db.get_system_setting(self._db_conn, "developer_mode", "0")
        self._dev_mode = dev_val == "1"
        mcp_val = await db.get_system_setting(self._db_conn, "mcp_enabled", "0")
        self._mcp_enabled = mcp_val == "1"
        mqtt_val = await db.get_system_setting(self._db_conn, "mqtt_enabled", "0")
        self._mqtt_enabled = mqtt_val == "1"
        self._theme = await db.get_system_setting(self._db_conn, "theme", "system")
        await self._load_vacation_state()
        self._eco_suspends = await db.get_all_eco_suspensions(self._db_conn)
        if self._unit_override not in ("F", "C"):
            self._active_unit = await db.get_system_setting(self._db_conn, "temperature_unit", "F")
        self._ha.dev_mode = self._dev_mode
        self._ha.set_dev_logger(self._event_logger)
        await self._sync_engines()
        log.info(
            "Scheduler DB reloaded (system_enabled=%s, dev_mode=%s)",
            self._system_enabled,
            self._dev_mode,
        )
        if self._event_logger:
            await self._event_logger.log("info", "system", "Database restored and reloaded")

    async def get_db(self) -> aiosqlite.Connection:
        return self._db_conn

    # ------------------------------------------------------------------
    # System enable / disable
    # ------------------------------------------------------------------

    def get_system_enabled(self) -> bool:
        return self._system_enabled

    def get_engine(self, thermostat_entity_id: str) -> CycleEngine | None:
        """Return the engine for a thermostat, or None if not (yet) created.

        Used by ``/api/thermostat-health`` to read per-zone availability state
        (Issue #267) without reaching into the private engine map.
        """
        return self._engines.get(thermostat_entity_id)

    async def set_system_enabled(self, enabled: bool) -> None:
        self._system_enabled = enabled
        await db.set_system_setting(self._db_conn, "system_enabled", "1" if enabled else "0")
        log.info("System %s", "enabled" if enabled else "disabled")
        await self._reset_and_reevaluate(reason=f"system {'enabled' if enabled else 'disabled'}")
        if self._broadcast:
            await self._broadcast("system_enabled_changed", {"enabled": enabled})

    def get_mcp_enabled(self) -> bool:
        return self._mcp_enabled

    async def set_mcp_enabled(self, enabled: bool) -> None:
        """Toggle the HTTP MCP server. Unlike the system toggle this does not
        touch HVAC control — it only opens/closes the MCP port (the ASGI app
        reads this flag per request and returns 503 when off)."""
        self._mcp_enabled = enabled
        await db.set_system_setting(self._db_conn, "mcp_enabled", "1" if enabled else "0")
        log.info("MCP server %s", "enabled" if enabled else "disabled")
        if self._broadcast:
            await self._broadcast("mcp_enabled_changed", {"mcp_enabled": enabled})

    def get_mqtt_enabled(self) -> bool:
        return self._mqtt_enabled

    async def set_mqtt_enabled(self, enabled: bool) -> None:
        """Toggle the MQTT bridge (Issue #519).

        The runtime twin of the ``mcp_enabled`` flag: the broker connection is
        configured at deploy time (add-on options / env), but whether HomeClimate
        actually connects and publishes is a per-install switch the user owns
        from the Settings page. Like the MCP toggle this never touches HVAC
        control — the bridge picks the change up and connects or disconnects.
        """
        self._mqtt_enabled = enabled
        await db.set_system_setting(self._db_conn, "mqtt_enabled", "1" if enabled else "0")
        log.info("MQTT bridge %s", "enabled" if enabled else "disabled")
        if self._broadcast:
            await self._broadcast("mqtt_enabled_changed", {"mqtt_enabled": enabled})

    def get_theme(self) -> str:
        return self._theme

    async def set_theme(self, theme: str) -> None:
        """Persist the UI theme preference ("light" | "dark" | "system") and
        broadcast it so other open tabs switch immediately. Display-only —
        nothing in the engine or scheduler behaves differently per theme."""
        self._theme = theme
        await db.set_system_setting(self._db_conn, "theme", theme)
        log.info("UI theme set to %s", theme)
        if self._broadcast:
            await self._broadcast("theme_changed", {"theme": theme})

    def get_dev_mode(self) -> bool:
        return self._dev_mode

    async def set_dev_mode(self, enabled: bool) -> None:
        self._dev_mode = enabled
        self._ha.dev_mode = enabled
        await db.set_system_setting(self._db_conn, "developer_mode", "1" if enabled else "0")
        log.info("Developer mode %s", "enabled" if enabled else "disabled")
        if self._event_logger:
            await self._event_logger.log(
                "info",
                "system",
                f"Developer mode {'enabled' if enabled else 'disabled'}",
            )
        await self._reset_and_reevaluate(
            reason=f"developer mode {'enabled' if enabled else 'disabled'}"
        )
        if self._broadcast:
            await self._broadcast("dev_mode_changed", {"dev_mode": enabled})

    # ------------------------------------------------------------------
    # Temperature unit
    # ------------------------------------------------------------------

    def get_temperature_unit(self) -> str:
        """Return the active temperature unit ('F' or 'C') for this session."""
        return self._active_unit

    async def get_unit_change_ack_required(self) -> bool:
        val = await db.get_system_setting(self._db_conn, "unit_change_ack_required", "0")
        return val == "1"

    async def ack_unit_change(self) -> None:
        """Clear the unit-change acknowledgement flag and record which HA unit was
        acknowledged, so the per-tick check does not immediately re-raise the
        banner for the same still-pending change (Issue #288). The mismatch is
        only truly resolved by the restart that applies the new unit."""
        await db.set_system_setting(self._db_conn, "unit_change_ack_required", "0")
        try:
            acked_unit = await self._ha.get_temperature_unit()
        except Exception:
            return
        await db.set_system_setting(self._db_conn, "unit_change_acked_unit", acked_unit)

    async def _clear_unit_change_banner(self) -> None:
        """Reset all unit-change banner bookkeeping (flag + acknowledged unit)."""
        await db.set_system_setting(self._db_conn, "unit_change_ack_required", "0")
        await db.set_system_setting(self._db_conn, "unit_change_acked_unit", "")

    # ------------------------------------------------------------------
    # Vacation mode
    # ------------------------------------------------------------------

    async def _load_vacation_state(self) -> None:
        """Read every vacation key from the DB (startup and post-restore).

        A key missing from an older DB reads as ``""``, which is exactly the
        off/active shape that existed before #728, so no data migration is
        needed.
        """
        conn = self._db_conn
        self._vacation_mode = await db.get_system_setting(conn, "vacation_mode_enabled", "0") == "1"
        self._vacation_return_at = _parse_instant(
            await db.get_system_setting(conn, "vacation_mode_return_at", "")
        )
        self._vacation_start_at = _parse_instant(
            await db.get_system_setting(conn, "vacation_mode_start_at", "")
        )
        if self._vacation_mode:
            # Active and scheduled can never both hold; a stray start key left
            # by a crash between the two writes is meaningless once active.
            self._vacation_start_at = None
        self._welcome_fired = _parse_json_dict(
            await db.get_system_setting(conn, "vacation_welcome_fired", "")
        )
        self._vacation_missed = _parse_json_dict(
            await db.get_system_setting(conn, "vacation_missed_notice", "")
        )

    def get_vacation_mode(self) -> bool:
        """True while a trip is ACTIVE (unchanged meaning since before #728)."""
        return self._vacation_mode

    def get_vacation_return_at(self) -> datetime | None:
        return self._vacation_return_at

    def get_vacation_start_at(self) -> datetime | None:
        """The scheduled start, set only while a trip is SCHEDULED."""
        return self._vacation_start_at

    def get_vacation_state(self) -> str:
        if self._vacation_mode:
            return VACATION_ACTIVE
        if self._vacation_start_at is not None:
            return VACATION_SCHEDULED
        return VACATION_OFF

    def is_vacation_for(self, thermostat_entity_id: str) -> bool:
        """Whether *this* thermostat's engine should run the vacation hold.

        Vacation is one global trip, but a thermostat leaves it early for its
        welcome-home tick (#728 §4.7): from then on its rooms follow their
        schedules and the synthetic presence like any normal day.
        """
        return self._vacation_mode and thermostat_entity_id not in self._welcome_fired

    def get_welcome_home_until(self, now: datetime | None = None) -> datetime | None:
        """End of the latest still-open welcome-home window, or None."""
        now = now or datetime.now(UTC)
        ends = [_parse_instant(rec.get("until", "")) for rec in self._welcome_fired.values()]
        open_ends = [e for e in ends if e is not None and e > now]
        return max(open_ends) if open_ends else None

    def get_vacation_snapshot(self) -> dict:
        """The vacation object every reader shares: REST, WebSocket, MQTT.

        ``enabled`` keeps meaning "active now", so readers written before #728
        behave exactly as they did.
        """
        welcome_until = self.get_welcome_home_until()
        return {
            "enabled": self._vacation_mode,
            "state": self.get_vacation_state(),
            "start_at": _iso_or_none(self._vacation_start_at),
            "return_at": _iso_or_none(self._vacation_return_at),
            "welcome_home_until": _iso_or_none(welcome_until),
            "missed": dict(self._vacation_missed) or None,
        }

    async def _broadcast_vacation(self) -> None:
        if self._broadcast:
            await self._broadcast("vacation_mode_changed", self.get_vacation_snapshot())

    async def _log_vacation(self, message: str, level: str = "info") -> None:
        log.info("%s", message)
        if self._event_logger:
            await self._event_logger.log(level, "system", message)

    @staticmethod
    def _local_label(value: datetime) -> str:
        return tz.to_local(value).strftime("%Y-%m-%d %H:%M %Z")

    async def _persist_trip_keys(self) -> None:
        conn = self._db_conn
        await db.set_system_setting(
            conn, "vacation_mode_enabled", "1" if self._vacation_mode else "0"
        )
        await db.set_system_setting(
            conn, "vacation_mode_return_at", _iso_or_none(self._vacation_return_at) or ""
        )
        await db.set_system_setting(
            conn, "vacation_mode_start_at", _iso_or_none(self._vacation_start_at) or ""
        )

    async def _persist_welcome_fired(self) -> None:
        await db.set_system_setting(
            self._db_conn,
            "vacation_welcome_fired",
            json.dumps(self._welcome_fired, sort_keys=True) if self._welcome_fired else "",
        )

    async def set_vacation_mode(
        self,
        enabled: bool,
        return_at: datetime | None = None,
        *,
        welcome_home: bool = True,
    ) -> None:
        """Turn vacation on now (until *return_at*) or off now.

        Kept for every caller written before #728. Turning it on replaces any
        scheduled trip; turning it off fires welcome home first unless
        ``welcome_home=False``.
        """
        async with self._vacation_lock:
            if enabled:
                await self._activate_locked(return_at, source="api")
            else:
                await self._end_or_cancel_locked(welcome_home=welcome_home)

    async def plan_vacation(
        self,
        return_at: datetime,
        start_at: datetime | None = None,
        now: datetime | None = None,
    ) -> None:
        """The POST: start now, schedule, edit a schedule, or move the return.

        ``start_at`` omitted or not in the future → start now (or, while
        active, just move the return). A future ``start_at`` schedules the trip
        and is rejected with :class:`VacationConflict` while one is active.
        The caller has already validated ``return_at`` is in the future and
        after ``start_at``.
        """
        now = now or datetime.now(UTC)
        async with self._vacation_lock:
            future_start = start_at is not None and start_at > now
            if self._vacation_mode:
                if future_start:
                    raise VacationConflict(VACATION_START_LOCKED)
                await self._move_return_locked(return_at)
                return
            if not future_start:
                await self._activate_locked(return_at, source="api")
                return
            assert start_at is not None
            editing = self._vacation_start_at is not None
            self._vacation_start_at = start_at
            self._vacation_return_at = return_at
            await self._persist_trip_keys()
            verb = "Scheduled vacation edited" if editing else "Vacation scheduled"
            await self._log_vacation(
                f"{verb}: starts {self._local_label(start_at)}, "
                f"returns {self._local_label(return_at)}"
            )
            await self._broadcast_vacation()

    async def _activate_locked(self, return_at: datetime | None, source: str) -> None:
        """Enter vacation now. Clears any scheduled start and any welcome-home
        record left by the previous trip, then resets every engine."""
        self._vacation_mode = True
        self._vacation_return_at = return_at
        self._vacation_start_at = None
        self._welcome_fired = {}
        await self._persist_trip_keys()
        await self._persist_welcome_fired()
        until = f" until {self._local_label(return_at)}" if return_at else ""
        suffix = " (scheduled start)" if source != "api" else ""
        await self._log_vacation(f"Vacation mode enabled{suffix}{until}")
        await self._reset_and_reevaluate(reason="vacation mode enabled")
        await self._broadcast_vacation()

    async def _move_return_locked(self, return_at: datetime) -> None:
        """Change the return of an ACTIVE trip without resetting every engine.

        Re-posting used to run the full enable path, force-aborting any running
        vacation safety cycle just to move a date (#728 side fix). Only a
        thermostat that had already left for its welcome-home tick is reset:
        the trip is longer now, so it goes back on the vacation hold and its
        welcome home fires again before the new return.
        """
        self._vacation_return_at = return_at
        rejoined = set(self._welcome_fired)
        self._welcome_fired = {}
        await self._persist_trip_keys()
        await self._persist_welcome_fired()
        await self._log_vacation(f"Vacation return moved to {self._local_label(return_at)}")
        if rejoined:
            await self._reset_and_reevaluate(
                reason="vacation extended after welcome home", only=rejoined
            )
        await self._broadcast_vacation()

    async def _end_or_cancel_locked(self, welcome_home: bool) -> None:
        if self._vacation_start_at is not None and not self._vacation_mode:
            self._vacation_start_at = None
            self._vacation_return_at = None
            await self._persist_trip_keys()
            await self._log_vacation("Scheduled vacation cancelled")
            await self._broadcast_vacation()
            return
        if self._vacation_mode and welcome_home:
            # Ending early by hand: welcome home fires now for every thermostat
            # that has it on and has not fired yet (#728 §4.7).
            now = datetime.now(UTC)
            for tid in list(self._engines):
                if tid not in self._welcome_fired:
                    tc = await db.get_thermostat_config(self._db_conn, tid)
                    if tc.welcome_home_enabled:
                        await self._fire_welcome_locked(tid, tc, now)
        await self._deactivate_locked()

    async def _deactivate_locked(self) -> None:
        # Thermostats already released for welcome home are running their
        # welcome cycles; resetting them here would abort that cycle at the
        # very moment the user walks in. Reset only the ones still on the hold.
        still_held = {tid for tid in self._engines if tid not in self._welcome_fired}
        self._vacation_mode = False
        self._vacation_return_at = None
        self._vacation_start_at = None
        await self._persist_trip_keys()
        await self._log_vacation("Vacation mode disabled")
        await self._reset_and_reevaluate(reason="vacation mode disabled", only=still_held)
        await self._broadcast_vacation()

    async def _check_vacation_start(self, now: datetime | None = None) -> None:
        """Activate a scheduled trip once its start time has passed (#728)."""
        if self._vacation_mode or self._vacation_start_at is None:
            return
        # The real clock, never tz.now_utc(): HOMECLIMATE_CLOCK_OVERRIDE is scoped
        # to the status read path only (#456), as the expiry check is.
        now = now or datetime.now(UTC)
        if now < self._vacation_start_at:
            return
        async with self._vacation_lock:
            start_at = self._vacation_start_at
            return_at = self._vacation_return_at
            # Re-check under the lock: a cancel may have won the race.
            if self._vacation_mode or start_at is None or now < start_at:
                return
            if return_at is not None and now >= return_at:
                await self._miss_trip_locked(start_at, return_at)
                return
            if (now - start_at).total_seconds() > _VACATION_LATE_START_S:
                await self._log_vacation(
                    f"Scheduled vacation start {self._local_label(start_at)} passed while "
                    "HomeClimate was offline — starting it now",
                    level="warning",
                )
            await self._activate_locked(return_at, source="scheduled")

    async def _miss_trip_locked(self, start_at: datetime, return_at: datetime) -> None:
        """The whole trip elapsed while HomeClimate was down: go straight to off and
        leave a notice the UI shows until it is dismissed (#728 §6.1)."""
        self._vacation_start_at = None
        self._vacation_return_at = None
        self._vacation_missed = {
            "start_at": start_at.isoformat(),
            "return_at": return_at.isoformat(),
        }
        await self._persist_trip_keys()
        await db.set_system_setting(
            self._db_conn, "vacation_missed_notice", json.dumps(self._vacation_missed)
        )
        await self._log_vacation(
            f"Scheduled vacation {self._local_label(start_at)} – {self._local_label(return_at)} "
            "was missed while HomeClimate was offline",
            level="warning",
        )
        await self._broadcast_vacation()

    async def dismiss_vacation_missed_notice(self) -> None:
        async with self._vacation_lock:
            self._vacation_missed = {}
            await db.set_system_setting(self._db_conn, "vacation_missed_notice", "")
            await self._broadcast_vacation()

    async def _check_welcome_home(self, now: datetime | None = None) -> None:
        """Fire each thermostat's one-time welcome-home tick once its lead time
        before the return has been reached (#728 §4.7)."""
        if not self._vacation_mode or self._vacation_return_at is None:
            return
        now = now or datetime.now(UTC)
        async with self._vacation_lock:
            if not self._vacation_mode or self._vacation_return_at is None:
                return
            for tid in list(self._engines):
                if tid in self._welcome_fired:
                    continue
                tc = await db.get_thermostat_config(self._db_conn, tid)
                if not tc.welcome_home_enabled:
                    continue
                fire_at = self._vacation_return_at - timedelta(minutes=tc.welcome_home_lead_min)
                if now >= fire_at:
                    await self._fire_welcome_locked(tid, tc, now)

    async def _fire_welcome_locked(self, tid: str, tc: ThermostatConfig, now: datetime) -> None:
        """One synthetic presence tick for every room on *tid*.

        Each eligible room gets a presence holdover ending ``welcome_home_hours``
        from now, never shortening a longer one. Room precedence is untouched:
        an active schedule or hold still outranks presence in ``_resolve_room``.
        Rooms with presence holdover 0 (presence off) or no presence
        temperature are skipped, exactly as a real presence event would be.
        """
        until = now + timedelta(hours=tc.welcome_home_hours)
        rooms = await db.get_rooms_for_thermostat(self._db_conn, tid)
        triggered = 0
        for room in rooms:
            if room.presence_holdover_hours <= 0:
                continue
            if room.system_wide_temp is None and tc.default_temp is None:
                continue
            existing = await db.get_holdover_state(self._db_conn, room.id)
            expires_at = until
            if existing is not None and existing.expires_at > until:
                expires_at = existing.expires_at
            await db.upsert_holdover_state(
                self._db_conn,
                PresenceHoldoverState(room_id=room.id, last_detected_at=now, expires_at=expires_at),
            )
            triggered += 1
        self._welcome_fired[tid] = {"fired_at": now.isoformat(), "until": until.isoformat()}
        await self._persist_welcome_fired()
        label = tc.name or tid
        await self._log_vacation(
            f"Welcome home started for {label}: {triggered} room(s) treated as occupied "
            f"until {self._local_label(until)}"
        )
        # This thermostat now leaves the vacation hold; abort whatever the hold
        # was running and let its rooms pick up their welcome demand at once.
        await self._reset_and_reevaluate(reason="welcome home", only={tid})
        await self._broadcast_vacation()

    async def _check_vacation_expiry(self, now: datetime | None = None) -> None:
        if not self._vacation_mode:
            return
        now = now or datetime.now(UTC)
        if not (self._vacation_return_at and now >= self._vacation_return_at):
            return
        async with self._vacation_lock:
            if not self._vacation_mode:
                return
            if self._vacation_return_at and now >= self._vacation_return_at:
                log.info("Vacation mode expired — resuming normal scheduling")
                await self._deactivate_locked()

    # ------------------------------------------------------------------
    # Eco Suspend (Issue #500)
    # ------------------------------------------------------------------

    def get_eco_suspensions(self) -> dict[str, datetime]:
        """Active suspensions as {thermostat_entity_id: resume_at}. Copy —
        callers may not mutate scheduler state."""
        return dict(self._eco_suspends)

    def get_eco_suspend_until(self, thermostat_entity_id: str) -> datetime | None:
        return self._eco_suspends.get(thermostat_entity_id)

    def is_eco_suspended(self, thermostat_entity_id: str) -> bool:
        """Whether Eco is suspended for this thermostat RIGHT NOW. Compares
        against the clock rather than mere row existence so an expired
        suspension stops gating even in the ≤60 s window before the sweep
        removes it."""
        until = self._eco_suspends.get(thermostat_entity_id)
        return until is not None and datetime.now(UTC) < until

    async def set_eco_suspend(self, thermostat_entity_id: str, resume_at: datetime | None) -> None:
        """Set (resume_at) or clear (None) the Eco suspension for a thermostat.

        Deliberately NO ``_reset_and_reevaluate`` here — Eco Suspend is
        next-cycle-only (#500): a cycle already running finishes under the Eco
        state it started with; the engine snapshots suspension at cycle start.
        """
        if resume_at is not None:
            self._eco_suspends[thermostat_entity_id] = resume_at
            await db.set_eco_suspension(self._db_conn, thermostat_entity_id, resume_at)
        else:
            self._eco_suspends.pop(thermostat_entity_id, None)
            await db.delete_eco_suspension(self._db_conn, thermostat_entity_id)
        log.info(
            "Eco Suspend %s for %s",
            f"active until {resume_at.isoformat()}" if resume_at else "cleared",
            thermostat_entity_id,
        )
        if self._event_logger:
            await self._event_logger.log(
                "info",
                "system",
                f"Eco Mode {'suspended until ' + resume_at.isoformat() if resume_at else 'resumed'}"
                f" for {thermostat_entity_id}",
                {"thermostat": thermostat_entity_id},
            )
        if self._broadcast:
            await self._broadcast(
                "eco_suspend_changed",
                {
                    "thermostat_entity_id": thermostat_entity_id,
                    "resume_at": resume_at.isoformat() if resume_at else None,
                },
            )

    async def _check_eco_suspend_expiry(self) -> None:
        now = datetime.now(UTC)
        for tid, until in list(self._eco_suspends.items()):
            if now >= until:
                log.info("Eco Suspend expired for %s — Eco Mode resumes", tid)
                await self.set_eco_suspend(tid, None)

    async def _startup_resolve_unit(self) -> None:
        """Background task: wait for HA to connect, then persist the detected unit."""
        try:
            await self._ha.wait_connected(timeout=60)
        except TimeoutError:
            return
        try:
            unit = await self._ha.get_temperature_unit()
        except Exception as exc:
            log.warning("Could not resolve temperature unit from HA: %s", exc)
            return
        self._active_unit = unit
        await db.set_system_setting(self._db_conn, "temperature_unit", unit)
        # The stored unit now matches HA, so any pending unit-change banner is
        # resolved by this (re)start — clear it even if the user never dismissed
        # it before restarting (Issue #288).
        await self._clear_unit_change_banner()
        log.info("Temperature unit resolved from HA on startup: %s", unit)

    async def _check_unit_change(self) -> None:
        """Called on each tick: detect HA unit changes and set the ack flag.

        The stored ``temperature_unit`` is only rewritten at startup (the running
        session's active unit is locked then), so a live HA unit change stays
        mismatched until the user restarts. To keep the dismiss meaningful we
        record the acknowledged HA unit and don't re-raise the banner for it; we
        re-flag only when HA moves to a unit that has not been acknowledged. Once
        the mismatch resolves (HA matches stored — e.g. after the applying
        restart) the banner bookkeeping is cleared. (Issue #288)
        """
        if not self._ha.is_connected:
            return
        if self._unit_override in ("F", "C"):
            return
        try:
            ha_unit = await self._ha.get_temperature_unit()
        except Exception:
            return
        stored = await db.get_system_setting(self._db_conn, "temperature_unit", "F")
        if ha_unit == stored:
            # No pending change (or it has been applied) — clear stale banner state.
            await self._clear_unit_change_banner()
            return
        acked = await db.get_system_setting(self._db_conn, "unit_change_acked_unit", "")
        if ha_unit != acked:
            await db.set_system_setting(self._db_conn, "unit_change_ack_required", "1")
            log.info(
                "Temperature unit change detected: stored=%s HA=%s — ack required",
                stored,
                ha_unit,
            )

    async def _reset_and_reevaluate(self, reason: str, only: set[str] | None = None) -> None:
        """Terminate every open cycle, then tick every engine so they re-evaluate
        what should be running under the new system/dev mode state.

        Invoked on every system/dev toggle (on or off). Guarantees that cycles
        from a previous mode never linger as ACTIVE after a transition and that
        engine state tracks the flag change without waiting for the next
        scheduled 60s tick.
        """
        engines = {tid: eng for tid, eng in self._engines.items() if only is None or tid in only}
        if not engines:
            return
        # 1. Force-abort any in-flight cycle in each engine — regardless of the
        # current enabled flag. The normal tick-driven abort only fires when
        # _get_enabled() is False, so transitions like system-on or
        # dev-off-while-system-on wouldn't otherwise clean up.
        for tid, eng in engines.items():
            try:
                await eng.force_abort(self._db_conn, reason=reason)
            except Exception as exc:
                log.error("force_abort failed for %s (%s): %s", tid, reason, exc)
        # 2. Safety net: close any cycle_log rows that are still open despite
        # the force_abort above. Catches edge cases where DB close inside
        # _abort_cycle failed, so the UI never shows stale "Active" cycles.
        for tid in engines:
            try:
                closed = await db.close_open_cycle_logs(self._db_conn, tid)
                if closed:
                    log.warning(
                        "Safety-net: closed %d orphaned cycle log(s) for %s after %s",
                        closed,
                        tid,
                        reason,
                    )
            except Exception as exc:
                log.error("Safety-net cycle cleanup failed for %s: %s", tid, exc)
        # 3. Re-evaluate: tick every engine so they start a fresh cycle if
        # still needed under the new flag state. Engines that are now disabled
        # will see that and skip; engines newly enabled will pick up work.
        tasks = [self._tick_engine(tid, eng) for tid, eng in engines.items()]
        await asyncio.gather(*tasks, return_exceptions=True)

    # ------------------------------------------------------------------
    # Engine management
    # ------------------------------------------------------------------

    async def refresh_engines(self) -> None:
        await self._load_heat_pumps()
        await self._sync_engines()

    async def _sync_engines(self) -> None:
        # Serialized (#434): invoked from both the 60 s tick and the API's
        # refresh_engines with awaits between the membership snapshot and the
        # removal — two interleaved syncs removing the same thermostat raced
        # to a KeyError that killed every zone's tick that round.
        async with self._sync_engines_lock:
            await self._sync_engines_locked()

    def _new_engine(self, tid: str, vent_ctrl: VentController) -> CycleEngine:
        """Build a cold ``CycleEngine`` for ``tid``.

        Factored out of ``_sync_engines_locked`` (#604) so a failed restore can
        replace the half-restored engine with a fresh one without duplicating
        the wiring. The constructor is pure — no I/O, no listener registration
        — so building a second one costs nothing.
        """
        return CycleEngine(
            thermostat_entity_id=tid,
            ha=self._ha,
            vent_ctrl=vent_ctrl,
            broadcast=self._broadcast,
            event_logger=self._event_logger,
            # Engine runs when system is enabled OR dev mode is on
            get_enabled=lambda: self._system_enabled or self._dev_mode,
            # Per thermostat (#728): a thermostat whose welcome-home tick has
            # fired leaves vacation before the global return time.
            get_vacation_mode=functools.partial(self.is_vacation_for, tid),
            get_eco_suspended=functools.partial(self.is_eco_suspended, tid),
            get_openings=functools.partial(self._pause_for, tid),
            get_fireplace_rooms=lambda: frozenset(self._fireplaces.set_aside_rooms()),
            get_building_side=functools.partial(self._building_side, tid),
            claim_building_side=functools.partial(self._building_plan_claim, tid),
            get_heat_pump=functools.partial(self._heat_pumps.get, tid),
            get_balance=functools.partial(self._balance_call, tid),
        )

    async def _sync_engines_locked(self) -> None:
        rooms = await db.get_all_rooms(self._db_conn)
        thermostat_ids = {r.thermostat_entity_id for r in rooms}

        assert self._vent_ctrl is not None
        for tid in thermostat_ids:
            if tid not in self._engines:
                engine = self._new_engine(tid, self._vent_ctrl)
                log.info("CycleEngine created for %s", tid)
                # Restore any in-progress cycle state from DB so the engine
                # doesn't start cold after a server restart. Restore-then-
                # publish (#428): restore_from_db runs outside the engine
                # lock and awaits many times — if the engine were already in
                # self._engines, a climate state-change event could dispatch
                # a tick mid-restore, see IDLE, start a fresh cycle (closing
                # the very log being restored), and then have its state
                # clobbered by the stale restore snapshot. Nothing can
                # address an engine that has not been published.
                #
                # #604: contain a failed restore to its own zone. This loop
                # runs inside aiohttp's on_startup and publishes each engine
                # only after its restore returns, so an exception here used to
                # cost every *other* thermostat's engine as well as the
                # process — a crash loop with no web UI to recover from.
                # restore_from_db validates the snapshot it reads, but it is
                # not total (db.get_open_cycle_logs parses started_at, for
                # one), and the containment should be structural rather than
                # dependent on every future line inside it staying defensive.
                #
                # What the degraded path actually does, precisely — a
                # half-restored engine is not safe to publish (its state is
                # whatever the exception interrupted), so it is discarded and
                # a fresh, cold one takes its place:
                #
                #   * The compressor off-time lockout (#432) is carried across
                #     to the replacement. It is rehydrated in restore_from_db's
                #     first block, under its own try, so it usually survived
                #     the failure — and a cold engine's None would re-enable an
                #     immediate compressor restart inside the very protection
                #     window a restart is supposed to preserve.
                #   * The open cycle_log row is CLOSED, the same way the
                #     thermostat-removal branch below closes one (#285). It
                #     cannot be resumed: the cold engine is IDLE with no
                #     _cycle_log, and both the timeout monitor and the
                #     reconciler act only on the engine's own _cycle_log, so
                #     leaving the row open would orphan it — the Logs page
                #     renders a permanently "Active" cycle, /metrics/live
                #     reports it as current, and its eventual close at the next
                #     cycle start bills the whole idle gap as runtime. Closing
                #     it here is a loud discard (log + event log), bounded to
                #     the restart, not a silent one.
                #   * The zone then starts a cycle from scratch on its next
                #     tick, exactly as a brand-new thermostat would.
                try:
                    await engine.restore_from_db(self._db_conn)
                except Exception:
                    log.exception(
                        "Cycle restore failed for %s — publishing a cold engine; "
                        "this zone starts a fresh cycle on its next tick",
                        tid,
                    )
                    cold = self._new_engine(tid, self._vent_ctrl)
                    # Pure attribute copy — cannot raise, and carries None
                    # harmlessly when the rehydrate never got that far.
                    cold._last_cycle_ended_at = engine._last_cycle_ended_at
                    cold._hold_compressor_off_at = engine._hold_compressor_off_at
                    engine = cold
                    try:
                        closed = await db.close_open_cycle_logs(self._db_conn, tid)
                        if closed:
                            log.warning(
                                "Closed %d open cycle log(s) for %s after a failed "
                                "restore — nothing would have supervised them",
                                closed,
                                tid,
                            )
                    except Exception as exc:
                        log.error("Cycle-log cleanup failed after a failed restore: %s", exc)
                    if self._event_logger:
                        await self._event_logger.log(
                            "error",
                            "engine",
                            f"Cycle restore failed for {tid} on startup — this zone starts cold",
                            {"thermostat": tid},
                        )
                self._engines[tid] = engine

        for tid in list(self._engines):
            if tid not in thermostat_ids:
                # The thermostat's last room was removed. Abort any in-flight
                # cycle first — otherwise the HA thermostat keeps the engine's
                # overshoot setpoint (HVAC runs on), vents stay in their cycle
                # positions, and the open cycle_log row is never closed, showing
                # a permanently "Active" cycle. The _reset_and_reevaluate orphan
                # safety net can't catch this engine because it only scans
                # engines still in the map. Abort + close before del. (#285)
                eng = self._engines[tid]
                try:
                    await eng.force_abort(self._db_conn, reason="thermostat removed")
                except Exception as exc:
                    log.error("force_abort failed while removing engine %s: %s", tid, exc)
                try:
                    closed = await db.close_open_cycle_logs(self._db_conn, tid)
                    if closed:
                        log.warning(
                            "Closed %d orphaned cycle log(s) for removed thermostat %s",
                            closed,
                            tid,
                        )
                except Exception as exc:
                    log.error("Cycle-log cleanup failed while removing engine %s: %s", tid, exc)
                self._engines.pop(tid, None)
                log.info("CycleEngine removed for %s", tid)

    # ------------------------------------------------------------------
    # Log purge
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Metrics rollup (Issue #85 Phase 1d/1e)
    # ------------------------------------------------------------------

    async def _rollup_daily_metrics_job(self) -> None:
        """APScheduler entry — recompute the local-date window [yesterday, today]."""
        await self.run_daily_metrics_rollup()

    async def _rollup_monthly_metrics_job(self) -> None:
        """APScheduler entry — recompute the [previous month, current month] window."""
        await self.run_monthly_metrics_rollup()

    async def run_daily_metrics_rollup(self, days_back: int = 1) -> int:
        """Recompute the daily metrics rollup for the last `days_back` local
        days plus today. Also exposed via the manual-trigger API endpoint
        (Issue #85 Phase 1d) so tests and operators can force a recompute.

        Returns the number of (date, thermostat) rows produced.
        """
        today_local = tz.today_local()
        start = today_local - timedelta(days=max(0, days_back))
        n = await db.rollup_daily_metrics(self._db_conn, start.isoformat(), today_local.isoformat())
        log.info(
            "Daily metrics rollup complete — %d row(s) for %s..%s",
            n,
            start.isoformat(),
            today_local.isoformat(),
        )
        return n

    async def run_monthly_metrics_rollup(self, months_back: int = 1) -> int:
        """Recompute monthly metrics for the last `months_back` whole months
        plus the current month-to-date. (#85 Phase 1e)

        Returns the number of (month, thermostat) rows produced.
        """
        today_local = tz.today_local()
        # Compute "month N back" by walking to the first of this month then back N months.
        first_of_this_month = today_local.replace(day=1)
        cur = first_of_this_month
        for _ in range(max(0, months_back)):
            cur = (cur - timedelta(days=1)).replace(day=1)
        start_month = cur.strftime("%Y-%m")
        end_month = today_local.strftime("%Y-%m")
        n = await db.rollup_monthly_metrics(self._db_conn, start_month, end_month)
        log.info(
            "Monthly metrics rollup complete — %d row(s) for %s..%s",
            n,
            start_month,
            end_month,
        )
        return n

    async def _purge_old_logs(self) -> None:
        """Delete event logs and, separately, metrics history past their windows.

        Three settings, three jobs, no overlap (Issue #617):

        - ``event_log_retention_days`` deletes ``event_log`` rows. ``event_log``
          is a genuine log — no metric reads it — so this purge cannot cost a
          chart anything, and is unchanged.
        - ``metrics_retention_days`` deletes ``cycle_logs``, and via
          ``ON DELETE CASCADE`` takes ``room_cycle_states`` and
          ``cycle_vent_events`` with it. ``cycle_logs`` is the source of record
          for **every** metric, so this is the only setting allowed to touch it.
          ``0`` means keep forever and skips the cycle purge entirely.
        - ``cycle_log_retention_days`` deletes **nothing** here any more. It is
          now the Cycle History *display* window (``_cycle_history_floor`` in
          ``api/routes.py``). Purging on it is exactly the defect #617 exists to
          remove: shrinking "how much history do I browse" silently erased every
          trend on the Metrics page.

        Storage note, stated plainly rather than hidden: an install that set
        ``cycle_log_retention_days`` low specifically to bound ``app.db`` now
        keeps ``cycle_logs`` for the *metrics* window instead. Setting
        ``metrics_retention_days`` to the old number restores the old storage
        profile exactly — but now as a deliberate choice about metrics.

        The ``demo-`` exemption (#442) lives in ``db.purge_cycle_logs`` /
        ``db.purge_event_logs`` and is untouched by any of this.
        """
        # Both windows read through the shared coercions, which bound them to
        # [minimum, db.MAX_RETENTION_DAYS]. The ceiling is load-bearing here and
        # not merely tidy: this coroutine is awaited unguarded from
        # `Scheduler.start()`, and a retention value big enough to overflow
        # `datetime.now(UTC) - timedelta(days=…)` would raise OverflowError out
        # of the purge and stop the add-on booting — with the UI needed to undo
        # the value never coming up.
        event_days = db.coerce_event_log_retention_days(
            await db.get_system_setting(
                self._db_conn,
                "event_log_retention_days",
                str(db.EVENT_LOG_RETENTION_DEFAULT_DAYS),
            )
        )
        metrics_days = db.coerce_metrics_retention_days(
            await db.get_system_setting(
                self._db_conn,
                "metrics_retention_days",
                str(db.METRICS_RETENTION_DEFAULT_DAYS),
            )
        )
        ev_count = await db.purge_event_logs(self._db_conn, event_days)
        # 0 = keep forever: skip the DELETE outright rather than passing 0 days,
        # which would compute a cutoff of "now" and delete the entire archive.
        cy_count = await db.purge_cycle_logs(self._db_conn, metrics_days) if metrics_days else 0
        if ev_count or cy_count:
            log.info(
                "Log purge complete — removed %d event rows (>%dd), %d cycle rows "
                "(metrics_retention_days=%d, 0 = keep forever)",
                ev_count,
                event_days,
                cy_count,
                metrics_days,
            )

    async def _sweep_expired_schedules(self) -> None:
        """Self-disable "temporary" schedules whose expiry has passed (#359).

        A schedule is disabled only once it is *not* in an active block at the
        moment of expiry — an in-progress block runs to its normal end_time
        first ("finish the current block"), and the next sweep disables it.
        Comparison is in local wall-clock via ``tz`` (``expires_at`` is stored
        naive-local). This sweep never deletes a schedule.
        """
        if not self._db_conn:
            return
        try:
            candidates = await db.get_expiring_schedules(self._db_conn)
        except Exception:
            log.exception("Failed to load expiring schedules for the expiry sweep")
            return

        now = tz.now_local()
        now_naive = now.replace(tzinfo=None)
        for s in candidates:
            if s.expires_at is None or now_naive < s.expires_at:
                continue  # never-expire or not yet expired
            if room_manager.schedule_active_at(s, now):
                continue  # finish the current block; disable on a later sweep
            s.enabled = False
            try:
                await db.upsert_schedule(self._db_conn, s)
                log.info(
                    "Auto-disabled expired schedule %s (room %s, expired %s)",
                    s.id,
                    s.room_id,
                    s.expires_at.isoformat(),
                )
            except Exception:
                log.exception("Failed to auto-disable expired schedule %s", s.id)

    # ------------------------------------------------------------------
    # Tick
    # ------------------------------------------------------------------

    @property
    def notifier(self) -> notify.Notifier:
        return self._notifier

    async def _on_logged_event(self, level: str, category: str, message: str) -> None:
        """Pass a logged event to the notifier, which decides whether to send it."""
        if self._db_conn is None:
            return
        await self._notifier.on_event(
            self._db_conn,
            self._ha,
            level=level,
            category=category,
            message=message,
            dev_mode=self._dev_mode,
            now=datetime.now(UTC),
        )

    async def _tick_all(self) -> None:
        await self._notifier.daily(
            self._db_conn, self._ha, dev_mode=self._dev_mode, now=datetime.now(UTC)
        )
        await self._check_vacation_start()
        await self._check_welcome_home()
        await self._check_vacation_expiry()
        await self._check_eco_suspend_expiry()
        await self._check_unit_change()
        await self._sync_engines()
        await self._refresh_continuous_presence()
        await self._refresh_reported_states()
        await self._evaluate_openings()
        await self._plan_buildings()
        await self._refresh_room_calendars()
        await self._evaluate_fireplaces()
        await self._plan_zone_balance()
        await self._load_heat_pumps()
        await self._watch_backup_heat()
        tasks = [self._tick_engine(tid, eng) for tid, eng in self._engines.items()]
        await asyncio.gather(*tasks, return_exceptions=True)
        await self._run_shades()

    @property
    def openings(self) -> openings.OpeningMonitor:
        return self._openings

    @property
    def fireplaces(self) -> fireplace.FireplaceMonitor:
        return self._fireplaces

    def _pause_for(self, thermostat_entity_id: str) -> tuple[bool, frozenset[str]]:
        """What the engine must leave out of demand: door and window pauses,
        plus rooms a lit fireplace is warming."""
        zone, rooms = self._openings.pause_for(thermostat_entity_id)
        return zone, rooms | frozenset(self._fireplaces.set_aside_rooms())

    async def _evaluate_fireplaces(self) -> set[str]:
        """Re-read every fireplace; log what changed and return the zones whose
        set-aside rooms changed."""
        before = self._fireplaces.set_aside_rooms()
        try:
            notes = await self._fireplaces.evaluate(
                self._db_conn,
                self._ha.get_state,
                datetime.now(UTC),
                connected=self._ha.is_connected,
            )
        except Exception:
            log.exception("Could not evaluate fireplaces")
            return set()
        after = self._fireplaces.set_aside_rooms()
        if not notes and before.keys() == after.keys():
            return set()
        rooms = {r.id: r for r in await db.get_all_rooms(self._db_conn)}
        for note in notes:
            f = note.fireplace
            names = ", ".join(sorted(rooms[r].name for r in f.room_ids if r in rooms)) or "no rooms"
            acting = f.control == "on"
            hold_h = fireplace.SIGNAL_LOST_HOLD.total_seconds() / 3600
            message = {
                fireplace.LIT: (
                    f"{f.name} is lit; {names} set aside"
                    if acting
                    else f"{f.name} is lit (watching only)"
                ),
                fireplace.COOLING: f"{f.name} is out; cooling down for {f.cooldown_min} min",
                fireplace.LOST: (
                    f"{f.name}: its signal stopped reporting while lit;"
                    f" treating it as lit for up to {hold_h:g} h"
                ),
                fireplace.LONG: (
                    f"{f.name} has read as lit for {fireplace.LONG_BURN.total_seconds() / 3600:g} h;"
                    " check that its signal was not left on"
                ),
                fireplace.OUT: (
                    f"{f.name} has cooled down; {names} back to normal"
                    if acting
                    else f"{f.name} has cooled down"
                ),
                fireplace.UNKNOWN: f"{f.name}: its signal is not reporting",
            }[note.kind]
            if self._event_logger is not None:
                await self._event_logger.log(
                    "warning"
                    if note.kind in (fireplace.UNKNOWN, fireplace.LOST, fireplace.LONG)
                    else "info",
                    "fireplace",
                    message,
                    {"fireplace": f.name, "event": note.kind, "control": f.control},
                )
        return {rooms[r].thermostat_entity_id for r in before.keys() ^ after.keys() if r in rooms}

    async def refresh_fireplaces(self) -> None:
        """Re-evaluate fireplaces now and tick any zone whose rooms changed."""
        for tid in await self._evaluate_fireplaces():
            engine = self._engines.get(tid)
            if engine is not None:
                await self._tick_engine(tid, engine)

    async def _evaluate_openings(self) -> set[str]:
        """Re-evaluate door/window pauses; log changes and return the zones hit."""
        try:
            transitions = await self._openings.evaluate(
                self._db_conn, self._ha.get_state, datetime.now(UTC)
            )
        except Exception:
            log.exception("Could not evaluate door and window pauses")
            return set()
        touched: set[str] = set()
        rooms = {r.id: r for r in await db.get_all_rooms(self._db_conn)}
        for t in transitions:
            if t.scope == "zone":
                touched.add(t.scope_id)
            elif t.scope_id in rooms:
                touched.add(rooms[t.scope_id].thermostat_entity_id)
            if self._event_logger is None:
                continue
            what = "Zone" if t.scope == "zone" else "Room"
            if t.paused:
                names = ", ".join(self._friendly(e) for e in t.sensors)
                message = f"{what} {t.name} paused: {names} open"
            else:
                message = f"{what} {t.name} resumed: doors and windows closed"
            await self._event_logger.log(
                "info",
                "openings",
                message,
                {
                    "scope": t.scope,
                    "scope_id": t.scope_id,
                    "paused": t.paused,
                    "sensors": t.sensors,
                },
            )
        return touched

    async def _load_heat_pumps(self) -> None:
        """Refresh heat pump guards in place (engines hold the dict's ``get``)."""
        profiles = await zones.list_zone_profiles(self._db_conn)
        self._zone_profiles = {z.thermostat_entity_id: z for z in profiles}
        now = datetime.now(UTC)
        fresh = {
            z.thermostat_entity_id: self._aux.apply_backoff(z.thermostat_entity_id, g, now)
            for z in profiles
            if (g := heat_pump.HeatPumpGuards.from_profile(z)) is not None
        }
        self._heat_pumps.clear()
        self._heat_pumps.update(fresh)

    def aux_heat_running(self, thermostat_entity_id: str) -> bool:
        return self._aux.running_since(thermostat_entity_id) is not None

    def strips_expected(self, thermostat_entity_id: str) -> bool:
        engine = self._engines.get(thermostat_entity_id)
        return engine is not None and engine.strips_expected

    async def _watch_backup_heat(self) -> None:
        """Log each backup (aux) heat episode seen on an equipment source."""
        now = datetime.now(UTC)
        backed_off: list[str] = []
        for tid, zone in self._zone_profiles.items():
            source = zone.equipment_running_entity
            running = heat_pump.aux_running(source, self._ha.get_state(source) if source else None)
            episode = self._aux.update(tid, running, now)
            if episode is None:
                continue
            if not episode.started:
                await heat_pump.record_episode(self._db_conn, episode, now)
            elif zone.is_heat_pump and zone.hp_aux_policy == "avoid":
                # Hold the setpoint closer for an hour so the compressor can
                # catch up without the strips (the back-off).
                self._aux.start_backoff(tid, now)
                backed_off.append(tid)
            if self._event_logger is None:
                continue
            name = zone.name or tid
            message = (
                f"Auxiliary heat started on {name}"
                + (", holding the setpoint closer for an hour" if tid in backed_off else "")
                if episode.started
                else f"Auxiliary heat stopped on {name} after {episode.minutes:g} min"
            )
            await self._event_logger.log(
                "warning" if episode.started else "info",
                "engine",
                message,
                {"thermostat": tid, "source": source, "minutes": episode.minutes},
            )
        if backed_off:
            await self._load_heat_pumps()
            for tid in backed_off:
                engine = self._engines.get(tid)
                if engine is not None:
                    await engine.heat_pump_backoff(self._db_conn)

    @property
    def forecast(self) -> forecast.Forecast:
        return self._forecast

    async def refresh_forecast(self) -> None:
        """Fetch the forecast; log only when it starts failing or recovers."""
        try:
            change = await self._forecast.refresh(self._db_conn, self._ha, now=datetime.now(UTC))
            if change and self._event_logger is not None:
                if change == "failed":
                    await self._event_logger.log(
                        "warning", "forecast", "Forecast fetch failed; keeping the last one", {}
                    )
                else:
                    await self._event_logger.log("info", "forecast", "Forecast is back", {})
            await forecast_bias.score(self._db_conn, now=datetime.now(UTC))
        except Exception:
            log.exception("Could not refresh the forecast")

    @property
    def shade_controller(self) -> shades.ShadeController:
        return self._shades

    def zone_mode(self, thermostat_entity_id: str) -> str | None:
        """The direction a zone is working in: its running cycle, else its mode."""
        engine = self._engines.get(thermostat_entity_id)
        if engine is not None and engine.cycle_mode is not None:
            return engine.cycle_mode
        state = (self._ha.get_state(thermostat_entity_id) or {}).get("state")
        return {"heat": "heating", "cool": "cooling"}.get(str(state))

    async def _sample_rooms(self) -> None:
        """Store one Smart Learning reading per room, and drop the oldest."""
        now = datetime.now(UTC)
        try:
            conn = self._db_conn
            settings = await learning.get_settings(conn)
            # Disconnected, Home Assistant's cached states are old news: a gap
            # in the record is honest, a stale reading with a fresh time is not.
            if settings["sampling_enabled"] and self._vent_ctrl and self._ha.is_connected:
                try:
                    stale = float(
                        await db.get_system_setting(
                            conn, "sensor_stale_after_min", str(SENSOR_STALE_AFTER_MIN)
                        )
                    )
                except ValueError:
                    stale = SENSOR_STALE_AFTER_MIN
                contacts: dict[str, list[str]] = {}
                for c in await openings.list_contacts(conn):
                    if c.room_id:
                        contacts.setdefault(c.room_id, []).append(
                            openings.classify(self._ha.get_state(c.entity_id))
                        )
                samples = await learning.collect(
                    conn,
                    self._ha,
                    now=now,
                    stale_after_min=stale,
                    vent_openness=self._vent_ctrl.openness,
                    aux_running=self.aux_heat_running,
                    contact_states=contacts,
                    fireplace_rooms=self._fireplaces.warmed_rooms(),
                )
                await learning.store(conn, samples)
        except Exception:
            # Sampling must never disturb control; the next run tries again.
            log.exception("Could not sample rooms for Smart Learning")
        try:
            keep = (await learning.get_settings(self._db_conn))["sample_retention_days"]
            await learning.purge(self._db_conn, now=now, keep_days=keep)
        except Exception:
            log.exception("Could not clear old Smart Learning readings")

    async def fit_room_models(self) -> int:
        """Fit every room's model; never raises. Returns how many rooms were fitted."""
        try:
            return await self.fit_room_models_now()
        except Exception:
            log.exception("Could not fit the room models")
            return 0

    async def fit_room_models_now(self) -> int:
        """Fit every room's model, letting a failure through to the caller."""
        models = await room_model.fit_all(self._db_conn, now=datetime.now(UTC))
        fitted = sum(1 for m in models if m.fitted_at is not None)
        if self._event_logger is not None:
            await self._event_logger.log(
                "info",
                "engine",
                f"Smart Learning fitted {fitted} of {len(models)} rooms",
                {"rooms": len(models), "fitted": fitted},
            )
        return fitted

    async def _run_shades(self) -> None:
        """Move shades for the sun, after the engines have settled their modes."""
        try:
            moves = await self._shades.run(
                self._db_conn, self._ha, self.zone_mode, datetime.now(UTC), tz.now_local().time()
            )
        except Exception:
            log.exception("Could not run shade automation")
            return
        if self._event_logger is None:
            return
        for move in moves:
            await self._event_logger.log(
                "info",
                "shades",
                f"{self._friendly(move.entity_id)}: {move.reason}",
                {"shade": move.entity_id, "action": move.action},
            )

    async def adopt_first_build_readings(self) -> None:
        """Move Smart Learning readings out of the first recorder build's table."""
        try:
            moved = await learning.adopt_first_build(self._db_conn)
        except Exception:
            # Old readings are not worth a failed start: control comes first.
            log.exception("Could not move Smart Learning readings into compact storage")
            return
        if moved:
            log.info("Moved %d Smart Learning readings into compact storage", moved)

    async def adopt_zone_contacts(self) -> None:
        """Move door and window sensors from before they belonged to rooms."""
        moved = await openings.adopt_zone_contacts(self._db_conn)
        if moved and self._event_logger is not None:
            await self._event_logger.log(
                "info",
                "openings",
                f"Moved {moved} door or window sensor(s) from their zone into a room",
                {"count": moved},
            )

    def _building_side(self, thermostat_entity_id: str) -> tuple[str | None, bool]:
        running = {tid: e.cycle_mode for tid, e in self._engines.items() if e.cycle_mode}
        return self._building_plan.live_side(thermostat_entity_id, running)

    def _building_plan_claim(self, thermostat_entity_id: str, direction: str) -> str | None:
        return self._building_plan.claim(thermostat_entity_id, direction)

    @property
    def building_plan(self) -> building_mode.Planner:
        return self._building_plan

    def zones_now(self) -> list[building_mode.ZoneNow]:
        return [
            building_mode.ZoneNow(
                tid, engine.cycle_mode, engine.building_wait, engine.protecting_only
            )
            for tid, engine in self._engines.items()
        ]

    async def _plan_buildings(self) -> None:
        """Decide each building's side before its zones tick; never raises."""
        try:
            now = datetime.now(UTC)
            hours, _fetched = await forecast.load(self._db_conn, now=now)
            if (await forecast.get_settings(self._db_conn))["correct"]:
                hours = (await forecast_bias.load(self._db_conn)).correct(hours)
            band = (await house.load(self._db_conn)).band
            switched = await self._building_plan.plan(
                self._db_conn, self.zones_now(), hours, band, now
            )
            if switched and self._event_logger is not None:
                names = {b.id: b.name for b in await zones.list_buildings(self._db_conn)}
                for building_id, side in switched:
                    await self._event_logger.log(
                        "info",
                        "engine",
                        f"{names.get(building_id, 'A building')} is now on {side}",
                        {"building": building_id, "side": side},
                    )
        except Exception:
            log.exception("Could not plan building modes")

    def _balance_call(self, thermostat_entity_id: str) -> zone_balance.Call | None:
        """The balancing call this zone is to answer; None when watching only."""
        found = self._balance_calls.get(thermostat_entity_id)
        return found[0] if found is not None and found[1] else None

    def building_direction(self, tids: list[str]) -> str | None:
        """The way a building is working: its side, or the way its zones are running."""
        # A side that is only being watched is not the way the building is working.
        sides = {side for side, obey in map(self._building_side, tids) if obey}
        if "off" in sides:
            return None
        for side in ("heating", "cooling"):
            if side in sides:
                return side
        running = {m for tid in tids if (m := self._engines[tid].cycle_mode)}
        return running.pop() if len(running) == 1 else None

    async def zone_states(self, *, refresh: bool = True) -> dict[str, zone_balance.ZoneState]:
        """Each zone's temperature and whether anyone is using it.

        ``refresh=False`` for a read from the API, which must not move the
        engines' sensor bookkeeping along (as for ``get_zone_status``).
        """
        the_house = await house.load(self._db_conn)
        set_aside = self._fireplaces.set_aside_rooms()
        states = {}
        for tid, engine in self._engines.items():
            temps = [
                temp + room.temp_offset
                for room in await db.get_rooms_for_thermostat(self._db_conn, tid)
                if the_house.switches(room.id).in_use
                and room.id not in set_aside
                and (temp := engine._get_avg_temp(room, refresh=refresh)) is not None
            ]
            asked = await get_active_rooms(self._db_conn, tid)
            states[tid] = zone_balance.ZoneState(
                tid,
                round(sum(temps) / len(temps), 1) if temps else None,
                any(ar.source != "house" for ar in asked),
            )
        return states

    async def _plan_zone_balance(self) -> None:
        """Work out each building's balancing calls before its zones tick; never raises."""
        try:
            settings = await zone_balance.load(self._db_conn)
            on = {b: s for b, s in settings.items() if s.level != "off"}
            calls: dict[str, tuple[zone_balance.Call, bool]] = {}
            if on:
                states = await self.zone_states()
                for building_id, setting in on.items():
                    tids = [
                        tid
                        for tid, z in self._zone_profiles.items()
                        if z.building_id == building_id and tid in states
                    ]
                    found = zone_balance.decide(
                        [states[tid] for tid in tids], self.building_direction(tids), setting.gap
                    )
                    for tid, call in found.items():
                        calls[tid] = (call, setting.level == "on")
            for tid, (call, obey) in calls.items():
                if self._balance_said.get(tid) != (call.mode, obey) and self._event_logger:

                    def name(t: str) -> str:
                        return self._zone_profiles[t].name or t

                    way = "colder" if call.mode == "heating" else "warmer"
                    does = "it is asked" if obey else "it would be asked (watching only)"
                    await self._event_logger.log(
                        "info",
                        "engine",
                        f"Zone Balance: {name(tid)} is {call.behind:g}°F {way} than "
                        f"{name(call.toward)}; {does} to {call.mode[:4]} to {call.target:g}°F",
                        {"thermostat": tid, "toward": call.toward, "target": call.target},
                    )
            self._balance_said = {tid: (c.mode, obey) for tid, (c, obey) in calls.items()}
            self._balance_calls = calls
        except Exception:
            log.exception("Zone Balance could not be worked out")
            self._balance_calls = {}

    def balance_answering(self, thermostat_entity_id: str) -> bool:
        """Whether rooms in the zone are being heated or cooled for balance right now."""
        engine = self._engines.get(thermostat_entity_id)
        return engine is not None and bool(engine.balance_rooms)

    @property
    def balance_calls(self) -> dict[str, tuple[zone_balance.Call, bool]]:
        return self._balance_calls

    async def replan_buildings_now(self) -> None:
        """After a building's mode changes: decide again and apply it at once."""
        await self._plan_buildings()
        await self._plan_zone_balance()
        await self.tick_all_now()

    async def _refresh_room_calendars(self) -> None:
        """Bring rooms that follow a calendar in and out of use, and say so."""
        try:
            changes, given_up = await self._calendars.refresh(
                self._db_conn, self._ha, datetime.now(UTC)
            )
            if self._event_logger is None:
                return
            for room_id in given_up:
                room = await db.get_room(self._db_conn, room_id)
                await self._event_logger.log(
                    "warning",
                    "engine",
                    f"The calendar {room.name if room else 'a room'} follows has not answered"
                    " for 30 minutes; treating the room as in use until it does",
                    {"room": room_id},
                )
            for room_id, in_use in changes:
                room = await db.get_room(self._db_conn, room_id)
                if room is not None:
                    await self._event_logger.log(
                        "info",
                        "engine",
                        f"{room.name} is {'in use' if in_use else 'not in use'} (calendar)",
                        {"room": room_id, "in_use": in_use},
                    )
        except Exception:
            log.exception("Could not read room calendars")

    @property
    def calendars(self) -> house.CalendarWatch:
        return self._calendars

    async def refresh_room_calendars_now(self) -> None:
        """After a calendar link changes: read it and apply the result at once."""
        await self._refresh_room_calendars()
        await self.tick_all_now()

    async def tick_all_now(self) -> None:
        """Tick every zone now, after a change to what rooms follow."""
        for tid, engine in list(self._engines.items()):
            await self._tick_engine(tid, engine)

    async def refresh_openings(self) -> None:
        """Re-evaluate pauses after a settings or sensor change and act at once."""
        for tid in await self._evaluate_openings():
            engine = self._engines.get(tid)
            if engine is not None:
                await self._tick_engine(tid, engine)

    def _friendly(self, entity_id: str) -> str:
        state = self._ha.get_state(entity_id) or {}
        return str((state.get("attributes") or {}).get("friendly_name") or entity_id)

    async def _refresh_reported_states(self) -> None:
        """Fallback freshness refresh when HA refused ``state_reported``.

        Without that subscription, a sensor that re-reports an unchanged value
        never reaches the cache, so the staleness guard would drop a working
        sensor. A once-a-minute snapshot carries every entity's current
        ``last_reported`` instead. Skipped while disconnected or when the
        subscription is live.
        """
        if self._ha.state_reported_supported is not False or not self._ha.is_connected:
            return
        try:
            await self._ha.refresh_states()
        except Exception:
            log.warning("Could not refresh HA states for sensor freshness", exc_info=True)

    async def _refresh_continuous_presence(self) -> None:
        """Refresh presence holdovers for rooms whose presence sensor currently
        reads "on".

        Presence is otherwise edge-triggered (``_on_state_change`` only fires on
        a transition to "on"). Many occupancy sensors (mmWave, some PIR
        aggregations) hold a single continuous "on" state while a room is
        occupied and emit no further state_changed events, so without this the
        holdover would expire mid-occupancy and the room would deactivate even
        though it is still occupied (Issue #287). Runs before the engine ticks so
        the refreshed holdover is visible when each tick resolves active rooms.
        """
        rooms = await db.get_all_rooms(self._db_conn)
        for room in rooms:
            if room.presence_holdover_hours <= 0:
                continue
            engine = self._engines.get(room.thermostat_entity_id)
            if engine is None:
                continue
            presence_sensors = await db.get_room_presence_sensors(self._db_conn, room.id)
            any_on = any(
                (state := self._ha.get_state(ps.entity_id)) and state.get("state") == "on"
                for ps in presence_sensors
            )
            # "Clear presence" suppression (#439): the user cleared the room's
            # presence while (by definition) still occupying it, so this
            # refresh must not resurrect the holdover — that made the Clear
            # button a no-op (the very next tick re-upserted a full holdover
            # from the still-on occupancy sensor). Skip the room while any
            # sensor reads on; once the room empties, re-arm so the next
            # genuine occupancy activates presence exactly as before.
            if await db.is_presence_suppressed(self._db_conn, room.id):
                if any_on:
                    continue
                await db.delete_presence_suppression(self._db_conn, room.id)
                if self._event_logger:
                    await self._event_logger.log(
                        "info",
                        "presence",
                        f"Room {room.name} emptied — cleared presence re-armed "
                        "(next occupancy activates presence normally)",
                        {"room_id": room.id},
                    )
                continue
            if any_on:
                await engine.handle_presence(self._db_conn, room)

    async def _tick_engine(self, tid: str, engine: CycleEngine) -> None:
        # The whole body — the pre-tick DB reads AND the tick — runs under the
        # retry loop. Previously the reads sat outside the try/except, so a
        # transient failure there propagated into _tick_all's
        # gather(return_exceptions=True) and was discarded with zero log output,
        # silently leaving the zone uncontrolled. Retry a few times (transient
        # locks clear in milliseconds) before giving up and surfacing the error
        # to container logs and the UI Live Feed. (Issue #286)
        for attempt in range(1, _TICK_MAX_ATTEMPTS + 1):
            try:
                rooms = await db.get_rooms_for_thermostat(self._db_conn, tid)
                await engine.load_room_sensors(self._db_conn, [r.id for r in rooms])
                await engine.tick(self._db_conn)
                return
            except Exception as exc:
                if attempt < _TICK_MAX_ATTEMPTS:
                    log.warning(
                        "Tick attempt %d/%d failed for %s: %s — retrying",
                        attempt,
                        _TICK_MAX_ATTEMPTS,
                        tid,
                        exc,
                    )
                    await asyncio.sleep(_TICK_RETRY_BACKOFF_S * attempt)
                    continue
                # Retries exhausted — log loudly and mirror to the event logger
                # so the UI Live Feed surfaces tick crashes (vent service errors,
                # HA unavailability, DB locks, anything else). Without this,
                # errors only land in container logs and the user has no way to
                # notice from inside the app.
                log.exception(
                    "Tick failed for %s after %d attempts: %s",
                    tid,
                    _TICK_MAX_ATTEMPTS,
                    exc,
                )
                if self._event_logger:
                    try:
                        await self._event_logger.log(
                            "error",
                            "engine",
                            f"Tick failed for {tid} after {_TICK_MAX_ATTEMPTS} attempts: {exc}",
                            {"thermostat": tid, "error": str(exc), "attempts": _TICK_MAX_ATTEMPTS},
                        )
                    except Exception:
                        log.exception("Failed to write tick error to event logger for %s", tid)

    # ------------------------------------------------------------------
    # HA state change dispatch
    # ------------------------------------------------------------------

    async def _on_state_change(self, entity_id: str, new_state: dict) -> None:
        if entity_id in self._openings.entities:
            self._openings.observe(entity_id, new_state, datetime.now(UTC))
            await self.refresh_openings()

        if entity_id in self._fireplaces.entities:
            await self.refresh_fireplaces()

        if entity_id.startswith("binary_sensor.") and new_state.get("state") == "on":
            await self._handle_presence_event(entity_id)

        if entity_id.startswith("climate.") and entity_id in self._engines:
            await self._tick_engine(entity_id, self._engines[entity_id])

    async def _handle_presence_event(self, presence_entity_id: str) -> None:
        rooms = await db.get_all_rooms(self._db_conn)
        for room in rooms:
            presence_sensors = await db.get_room_presence_sensors(self._db_conn, room.id)
            for ps in presence_sensors:
                if ps.entity_id == presence_entity_id:
                    # User-cleared presence (#439): stay suppressed until the
                    # room empties. Continuous sensors can emit extra "on"
                    # events (attribute changes) for the same occupancy — they
                    # must not undo the clear. The refresh sweep re-arms once
                    # every sensor reads off.
                    if await db.is_presence_suppressed(self._db_conn, room.id):
                        log.debug(
                            "Presence event for %s ignored — presence was "
                            "cleared and the room has not emptied yet",
                            room.name,
                        )
                        continue
                    if self._event_logger:
                        await self._event_logger.log(
                            "info",
                            "presence",
                            f"Presence detected in {room.name} via {presence_entity_id}",
                            {"room_id": room.id, "sensor": presence_entity_id},
                        )
                    engine = self._engines.get(room.thermostat_entity_id)
                    if engine:
                        await engine.handle_presence(self._db_conn, room)
                        await self._tick_engine(room.thermostat_entity_id, engine)

    async def kick_thermostat(self, thermostat_entity_id: str) -> None:
        """Run one engine tick for a thermostat immediately (API-triggered).

        Used by write endpoints whose effect the user expects to SEE at once —
        e.g. clearing presence (#439) — instead of waiting for the next 60 s
        scheduler tick to re-resolve active rooms and rebroadcast zone status.
        No-op for an unknown thermostat.
        """
        engine = self._engines.get(thermostat_entity_id)
        if engine is not None:
            await self._tick_engine(thermostat_entity_id, engine)

    # ------------------------------------------------------------------
    # Status helpers for API
    # ------------------------------------------------------------------

    def get_all_zone_statuses(self) -> list[dict]:
        return [
            {
                "thermostat_entity_id": tid,
                "cycle_state": engine.cycle_state.value,
                **self._zone_status_dict(engine),
            }
            for tid, engine in self._engines.items()
        ]

    def _zone_status_dict(self, engine: CycleEngine) -> dict:
        s = engine.get_zone_status()
        return {
            "hvac_mode": s.hvac_mode,
            "hvac_action": s.hvac_action,
            "current_temp": s.current_temp,
            "setpoint": s.setpoint,
            "cycle_id": s.cycle_id,
            "cycle_started_at": s.cycle_started_at.isoformat() if s.cycle_started_at else None,
            "coasting_rooms": s.coasting_rooms,
            "balance_rooms": s.balance_rooms,
            "rooms": [
                {
                    "room_id": r.room_id,
                    "avg_temp": r.avg_temp,
                    "vent_states": r.vent_states,
                    "presence_active": r.presence_active,
                    "target_temp": r.target_temp,
                    # Eco Mode (Issue #404): pre-relaxation ask + whether Eco is
                    # relaxing this room right now, for the Dashboard indicator.
                    "requested_target": r.requested_target,
                    "eco_active": r.eco_active,
                }
                for r in s.rooms
            ],
        }
