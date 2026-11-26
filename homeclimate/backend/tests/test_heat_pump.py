"""Heat pump protection: guards, backup-heat detection and engine behaviour."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import aiosqlite
import pytest

from backend import db
from backend.engine.cycle_engine import CycleState
from backend.engine.room_manager import ActiveRoom
from backend.heat_pump import AuxMonitor, HeatPumpGuards, aux_running
from backend.models import CycleLog, Room, ThermostatConfig
from backend.zones import ZoneProfile

from .test_cycle_engine import THERMO_ID, _make_engine, _make_ha

GUARDS = HeatPumpGuards(
    max_step_f=1.0,
    recovery_f_per_hr=2.0,
    min_runtime_min=15,
    min_open_heat_fraction=0.5,
    switchover_gap_min=60,
)
T0 = datetime(2026, 1, 5, 6, 0, tzinfo=UTC)


def test_guards_only_for_heat_pumps():
    assert HeatPumpGuards.from_profile(ZoneProfile(THERMO_ID)) is None
    guards = HeatPumpGuards.from_profile(
        ZoneProfile(THERMO_ID, system_type="heat_pump", hp_min_open_heat_pct=40)
    )
    assert guards == HeatPumpGuards(1.0, 2.0, 15, 0.4, 60)
    allow = HeatPumpGuards.from_profile(
        ZoneProfile(THERMO_ID, system_type="heat_pump", hp_aux_policy="allow")
    )
    assert allow is not None and allow.avoid_aux is False


@pytest.mark.parametrize(
    ("entity", "state", "expected"),
    [
        (None, {"state": "on"}, False),
        ("climate.cloud", None, False),
        ("climate.cloud", {"attributes": {"equipment_running": "heatPump,fan,auxHeat1"}}, True),
        ("climate.cloud", {"attributes": {"equipment_running": "heatPump,fan"}}, False),
        ("climate.cloud", {"attributes": {}}, False),
        ("sensor.strip_power", {"state": "4800"}, True),
        ("sensor.strip_power", {"state": "12.5"}, False),
        ("sensor.equipment", {"state": "auxHeat1"}, True),
        ("sensor.equipment", {"state": "unavailable"}, False),
        ("sensor.equipment", {}, False),
    ],
)
def test_aux_running(entity, state, expected):
    assert aux_running(entity, state) is expected


def test_aux_monitor_episodes():
    mon = AuxMonitor()
    assert mon.update("climate.a", False, T0) is None
    started = mon.update("climate.a", True, T0)
    assert started is not None and started.started
    assert mon.running_since("climate.a") == T0
    assert mon.update("climate.a", True, T0 + timedelta(minutes=5)) is None
    stopped = mon.update("climate.a", False, T0 + timedelta(minutes=12, seconds=30))
    assert stopped is not None and (stopped.started, stopped.minutes) == (False, 12.5)
    assert mon.running_since("climate.a") is None


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


async def _conn() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row
    await db.init_db(conn)
    await db.upsert_thermostat_config(
        conn,
        ThermostatConfig(
            thermostat_entity_id=THERMO_ID,
            min_cycle_runtime_min=5,
            min_open_vents_fraction=0.25,
            overshoot_delta=2.0,
            max_setpoint=80.0,
        ),
    )
    return conn


def _hp_engine(ambient: float, guards: HeatPumpGuards | None = GUARDS):
    ha = _make_ha(ambient=ambient)
    engine = _make_engine(ha)
    engine._get_heat_pump = lambda: guards
    return engine, ha


async def test_load_tc_applies_floors_only_for_heat_pumps():
    conn = await _conn()
    engine, _ = _hp_engine(68.0)
    tc = await engine._load_tc(conn, "heating")
    assert (tc.min_cycle_runtime_min, tc.min_open_vents_fraction) == (15, 0.5)
    tc = await engine._load_tc(conn, "cooling")
    assert (tc.min_cycle_runtime_min, tc.min_open_vents_fraction) == (15, 0.25)
    engine._cycle_mode = "heating"
    assert (await engine._load_tc(conn)).min_open_vents_fraction == 0.5
    stored = await db.get_thermostat_config(conn, THERMO_ID)
    assert stored.min_cycle_runtime_min == 5

    plain, _ = _hp_engine(68.0, guards=None)
    assert (await plain._load_tc(conn, "heating")).min_cycle_runtime_min == 5
    no_callback = _make_engine(_make_ha(ambient=68.0))
    assert no_callback._heat_pump() is None
    await conn.close()


def _active(engine, target: float) -> None:
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    engine._active_rooms = {room.id: ActiveRoom(room=room, target_temp=target, source="schedule")}


async def test_heating_setpoint_is_capped_and_rounded_down():
    conn = await _conn()
    engine, ha = _hp_engine(68.2)
    _active(engine, 72.0)
    tc = await engine._load_tc(conn, "heating")
    await engine._set_thermostat_setpoint(tc, "heating", conn=conn)
    # 72 + 2 overshoot = 74, capped to 68.2 + 1 = 69.2, rounded down to 69.
    assert ha.set_thermostat_temperature.await_args.args[1] == 69.0

    # Never below half a degree over the reading: 68.9 gives cap 69.9, which
    # rounds down to 69, but the floor is ceil(68.9 + 0.5) = 70.
    engine2, ha2 = _hp_engine(68.9)
    _active(engine2, 72.0)
    await engine2._set_thermostat_setpoint(tc, "heating", conn=conn)
    assert ha2.set_thermostat_temperature.await_args.args[1] == 70.0

    # Cooling is never capped; a conventional zone is never capped.
    engine3, ha3 = _hp_engine(76.0)
    _active(engine3, 72.0)
    await engine3._set_thermostat_setpoint(tc, "cooling", conn=conn)
    assert ha3.set_thermostat_temperature.await_args.args[1] == 70.0
    engine4, ha4 = _hp_engine(68.2, guards=None)
    _active(engine4, 72.0)
    await engine4._set_thermostat_setpoint(tc, "heating", conn=conn)
    assert ha4.set_thermostat_temperature.await_args.args[1] == 74.0
    await conn.close()


async def test_recovery_rate_limits_the_cap():
    engine, _ = _hp_engine(68.0)
    engine._hp_ramp_start = (T0, 66.0)
    # Ambient term: 69. Ramp term after 30 min: 66 + 1 + 2 * 0.5 = 68.
    assert engine._heat_pump_cap(68.0, now=T0 + timedelta(minutes=30)) == 68.0
    assert engine._heat_pump_cap(68.0, now=T0 + timedelta(hours=3)) == 69.0
    engine._get_heat_pump = lambda: None
    assert engine._heat_pump_cap(68.0) is None


async def test_ramp_raises_the_setpoint_as_the_room_warms():
    conn = await _conn()
    engine, ha = _hp_engine(68.2)
    _active(engine, 72.0)
    engine._state = CycleState.RUNNING
    engine._cycle_mode = "heating"
    engine._last_setpoint_sent = 69.0
    engine._set_thermostat_setpoint = AsyncMock()

    await engine._heat_pump_ramp(conn)  # cap still 69: nothing to do
    engine._set_thermostat_setpoint.assert_not_awaited()

    ha.get_state.return_value["attributes"]["current_temperature"] = 69.1
    await engine._heat_pump_ramp(conn)
    assert engine._set_thermostat_setpoint.await_args.kwargs["setpoint_reason"] == "heat pump ramp"

    # Already at the goal (72 + 2 = 74): stop raising.
    engine._set_thermostat_setpoint.reset_mock()
    engine._last_setpoint_sent = 74.0
    await engine._heat_pump_ramp(conn)
    engine._set_thermostat_setpoint.assert_not_awaited()

    # No reading, not heating, or not running: nothing.
    engine._last_setpoint_sent = 69.0
    ha.get_state.return_value["attributes"]["current_temperature"] = None
    await engine._heat_pump_ramp(conn)
    engine._cycle_mode = "cooling"
    await engine._heat_pump_ramp(conn)
    engine._set_thermostat_setpoint.assert_not_awaited()
    await conn.close()


async def _log_cycle(conn, mode: str, ended_at: datetime) -> None:
    cycle = CycleLog.create(thermostat_entity_id=THERMO_ID, mode=mode, rooms_json="{}")
    await db.insert_cycle_log(conn, cycle)
    await conn.execute(
        "UPDATE cycle_logs SET ended_at=? WHERE id=?", (ended_at.isoformat(), cycle.id)
    )
    await conn.commit()


async def test_switchover_gap():
    conn = await _conn()
    engine, _ = _hp_engine(70.0)
    logger = AsyncMock()
    engine._logger = logger
    now = T0 + timedelta(minutes=30)

    assert await engine._heat_pump_switchover_wait(conn, "heating", now=now) is False
    await _log_cycle(conn, "cooling", T0)
    assert await engine._heat_pump_switchover_wait(conn, "cooling", now=now) is False
    assert await engine._heat_pump_switchover_wait(conn, "heating", now=now) is True
    assert await engine._heat_pump_switchover_wait(conn, "heating", now=now) is True
    assert logger.log.await_count == 1  # announced once per wait
    assert (
        await engine._heat_pump_switchover_wait(conn, "heating", now=T0 + timedelta(hours=1))
        is False
    )

    # Naive timestamps are read as UTC; no logger is fine; a zero gap never waits.
    await conn.execute("UPDATE cycle_logs SET ended_at=?", (T0.replace(tzinfo=None).isoformat(),))
    await conn.commit()
    engine._logger = None
    assert await engine._heat_pump_switchover_wait(conn, "heating", now=now) is True
    engine._get_heat_pump = lambda: HeatPumpGuards(1.0, 2.0, 15, 0.5, 0)
    assert await engine._heat_pump_switchover_wait(conn, "heating", now=now) is False
    await conn.close()


async def test_switchover_wait_parks_instead_of_starting():
    from datetime import time

    from backend.models import Schedule

    conn = await _conn()
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    await db.upsert_schedule(
        conn,
        Schedule.create(
            room_id=room.id,
            days_of_week=list(range(7)),
            start_time=time(0, 0),
            end_time=time(23, 59),
            target_temp=72.0,
        ),
    )
    engine, _ = _hp_engine(66.0)
    engine._infer_mode_from_room_temps = AsyncMock(return_value="heating")
    engine._heat_pump_switchover_wait = AsyncMock(return_value=True)
    engine._reset_setpoint_to_ambient = AsyncMock()
    await engine._do_tick(conn)
    engine._reset_setpoint_to_ambient.assert_awaited_once()
    assert engine.cycle_state == CycleState.IDLE
    await conn.close()


async def test_fresh_heating_cycle_starts_the_ramp():
    conn = await _conn()
    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    engine, _ = _hp_engine(66.0)
    active = {room.id: ActiveRoom(room=room, target_temp=70.0, source="schedule")}
    await engine._start_or_update_cycle(conn, active, "heating")
    assert engine._hp_ramp_start is not None
    assert engine._hp_ramp_start[1] == 66.0
    await conn.close()


# ---------------------------------------------------------------------------
# Strips Expected, early warm-ups, back-off, defrost allowance
# ---------------------------------------------------------------------------

LOCKOUT = HeatPumpGuards(1.0, 2.0, 15, 0.5, 60, compressor_lockout_f=20.0)


async def test_strips_expected_follows_the_outdoor_temperature():
    conn = await _conn()
    engine, _ = _hp_engine(66.0, guards=LOCKOUT)
    logger = AsyncMock()
    engine._logger = logger
    engine._read_outside_temp = AsyncMock(return_value=15.0)
    assert await engine._heat_pump_strips_expected(conn) is True
    assert engine.strips_expected
    tc = await engine._load_tc(conn, "heating")
    assert tc.deadband == (await db.get_thermostat_config(conn, THERMO_ID)).deadband + 1.0
    assert (await engine._load_tc(conn, "cooling")).deadband == tc.deadband - 1.0
    engine._read_outside_temp = AsyncMock(return_value=25.0)
    assert await engine._heat_pump_strips_expected(conn) is False
    assert logger.log.await_count == 2
    engine._read_outside_temp = AsyncMock(return_value=None)
    assert await engine._heat_pump_strips_expected(conn) is False
    # No lockout configured, or not a heat pump: never.
    engine._get_heat_pump = lambda: GUARDS
    assert await engine._heat_pump_strips_expected(conn) is False
    engine._logger = None
    engine._get_heat_pump = lambda: LOCKOUT
    engine._read_outside_temp = AsyncMock(return_value=0.0)
    assert await engine._heat_pump_strips_expected(conn) is True
    await conn.close()


async def _scheduled_room(conn, start_hour: int, target: float):
    from datetime import time

    from backend.models import Schedule

    room = Room.create(name="Bunk Room", thermostat_entity_id=THERMO_ID)
    await db.upsert_room(conn, room)
    await db.upsert_schedule(
        conn,
        Schedule.create(
            room_id=room.id,
            days_of_week=list(range(7)),
            start_time=time(start_hour, 0),
            end_time=time(start_hour, 59),
            target_temp=target,
        ),
    )
    return room


async def test_warmups_start_early_only_when_needed(monkeypatch):
    from backend import tz

    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)
    conn = await _conn()
    room = await _scheduled_room(conn, 7, 70.0)
    engine, ha = _hp_engine(64.0)
    ha.get_state.return_value["state"] = "heat"
    logger = AsyncMock()
    engine._logger = logger
    engine._get_avg_temp = lambda _room, **_k: 66.0
    # 4 °F at 2 °F/hr = 2 h of lead. 05:30 is 1.5 h before 07:00: start.
    now = datetime(2026, 1, 5, 5, 30, tzinfo=UTC)
    active = await engine._heat_pump_warmups(conn, [], now=now)
    assert [(ar.room.id, ar.target_temp, ar.source) for ar in active] == [
        (room.id, 70.0, "schedule")
    ]
    await engine._heat_pump_warmups(conn, [], now=now)
    assert logger.log.await_count == 1  # announced once per block
    # Once started it is kept until the block begins: a room that warms faster
    # than the recovery rate must not drop out and come back.
    engine._get_avg_temp = lambda _room, **_k: 69.5
    kept = await engine._heat_pump_warmups(conn, [], now=now + timedelta(minutes=10))
    assert [ar.target_temp for ar in kept] == [70.0]
    assert logger.log.await_count == 1
    # A reading that goes missing for a tick does not drop it either.
    engine._get_avg_temp = lambda _room, **_k: None
    assert len(await engine._heat_pump_warmups(conn, [], now=now + timedelta(minutes=11))) == 1
    engine._get_avg_temp = lambda _room, **_k: 69.5
    engine._hp_latch = {}
    assert await engine._heat_pump_warmups(conn, [], now=now + timedelta(minutes=10)) == []
    engine._get_avg_temp = lambda _room, **_k: 66.0
    # The same block next week is announced again.
    await engine._heat_pump_warmups(conn, [], now=now + timedelta(days=7))
    assert logger.log.await_count == 2 and len(engine._hp_warmups_logged) == 1
    engine._hp_latch = {}
    # 04:30 is 2.5 h before: too early.
    assert await engine._heat_pump_warmups(conn, [], now=now - timedelta(hours=1)) == []
    # Already active, warm enough, or no reading: nothing added.
    assert await engine._heat_pump_warmups(conn, active, now=now) == active
    assert engine._hp_latch == {}
    engine._get_avg_temp = lambda _room, **_k: 71.0
    assert await engine._heat_pump_warmups(conn, [], now=now) == []
    engine._get_avg_temp = lambda _room, **_k: None
    assert await engine._heat_pump_warmups(conn, [], now=now) == []
    # Not in heat mode, strips expected, or not a heat pump: never.
    engine._get_avg_temp = lambda _room, **_k: 66.0
    engine._hp_strips = True
    assert await engine._heat_pump_warmups(conn, [], now=now) == []
    engine._hp_strips = False
    ha.get_state.return_value["state"] = "cool"
    assert await engine._heat_pump_warmups(conn, [], now=now) == []
    ha.get_state.return_value["state"] = "heat"
    engine._logger = None
    engine._hp_warmups_logged.clear()
    assert len(await engine._heat_pump_warmups(conn, [], now=now)) == 1
    engine._get_heat_pump = lambda: None
    assert await engine._heat_pump_warmups(conn, [], now=now) == []
    await conn.close()


async def test_warmup_lead_is_capped_and_rooms_without_schedules_are_skipped(monkeypatch):
    from backend import tz

    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)
    conn = await _conn()
    await _scheduled_room(conn, 7, 75.0)
    await db.upsert_room(conn, Room.create(name="Craft Room", thermostat_entity_id=THERMO_ID))
    engine, ha = _hp_engine(60.0)
    ha.get_state.return_value["state"] = "heat"
    engine._get_avg_temp = lambda _room, **_k: 60.0
    # 15 °F would need 7.5 h; capped at 3 h, so 03:30 is too early, 04:30 is not.
    assert (
        await engine._heat_pump_warmups(conn, [], now=datetime(2026, 1, 5, 3, 30, tzinfo=UTC)) == []
    )
    assert (
        len(await engine._heat_pump_warmups(conn, [], now=datetime(2026, 1, 5, 4, 30, tzinfo=UTC)))
        == 1
    )
    await conn.close()


async def test_backoff_resends_the_setpoint_only_while_heating():
    conn = await _conn()
    engine, _ = _hp_engine(66.0)
    engine._set_thermostat_setpoint = AsyncMock()
    await engine.heat_pump_backoff(conn)
    engine._set_thermostat_setpoint.assert_not_awaited()
    _active(engine, 70.0)
    engine._state = CycleState.RUNNING
    engine._cycle_mode = "heating"
    await engine.heat_pump_backoff(conn)
    assert engine._set_thermostat_setpoint.await_args.kwargs["setpoint_reason"] == (
        "auxiliary heat back-off"
    )
    await conn.close()


def test_backoff_guards():
    mon = AuxMonitor()
    assert mon.apply_backoff("climate.a", GUARDS, T0) is GUARDS
    mon.start_backoff("climate.a", T0)
    assert mon.apply_backoff("climate.a", GUARDS, T0 + timedelta(minutes=30)).max_step_f == 0.5
    assert mon.apply_backoff("climate.a", GUARDS, T0 + timedelta(minutes=61)) is GUARDS


async def test_heat_pump_heating_cycles_get_a_longer_timeout():
    engine, _ = _hp_engine(66.0)
    tc = ThermostatConfig(thermostat_entity_id=THERMO_ID, cycle_timeout_hours=2)
    engine._cycle_mode = "heating"
    assert engine._cycle_timeout_hours(tc) == 3.0
    engine._cycle_mode = "cooling"
    assert engine._cycle_timeout_hours(tc) == 2.0
    engine._get_heat_pump = lambda: None
    engine._cycle_mode = "heating"
    assert engine._cycle_timeout_hours(tc) == 2.0
