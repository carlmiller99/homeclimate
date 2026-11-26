"""Sensor freshness from HA's ``last_reported`` (HomeClimate phase 2).

A sensor in a steady room re-reports the same value; HA moves only
``last_reported`` for that, never ``last_updated``. Freshness must follow the
newest of the three timestamps, live via ``state_reported`` events when HA
allows the subscription, and through a once-a-minute refresh when it doesn't.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.ha_client import HAClient


def _iso(minutes_ago: float) -> str:
    return (datetime.now(UTC) - timedelta(minutes=minutes_ago)).isoformat()


class TestStateAge:
    def test_last_reported_wins_when_newest(self):
        state = {"last_changed": _iso(300), "last_updated": _iso(300), "last_reported": _iso(1)}
        assert HAClient._state_age(state) < timedelta(minutes=2)

    def test_last_updated_wins_when_newest(self):
        state = {"last_changed": _iso(300), "last_updated": _iso(3), "last_reported": _iso(200)}
        age = HAClient._state_age(state)
        assert timedelta(minutes=2) < age < timedelta(minutes=4)

    def test_malformed_and_non_string_stamps_are_ignored(self):
        state = {"last_changed": _iso(10), "last_updated": "garbage", "last_reported": 12345}
        age = HAClient._state_age(state)
        assert timedelta(minutes=9) < age < timedelta(minutes=11)

    def test_no_usable_stamp_is_infinitely_old(self):
        assert HAClient._state_age({"last_updated": "nope"}) == timedelta.max
        assert HAClient._state_age({}) == timedelta.max

    def test_unchanged_but_reported_sensor_passes_the_freshness_guard(self):
        client = HAClient("ws://ha.local", "tok")
        client._state_cache["sensor.t"] = {
            "state": "70.1",
            "last_changed": _iso(240),
            "last_updated": _iso(240),
            "last_reported": _iso(1),
            "attributes": {"unit_of_measurement": "°F"},
        }
        assert client.get_numeric_state("sensor.t", max_age_min=120) == 70.1
        assert client.get_state_age_seconds("sensor.t") < 120


def _ws_with(messages: list[dict]) -> MagicMock:
    ws = MagicMock()
    ws.send_json = AsyncMock()
    ws.receive_json = AsyncMock(side_effect=messages)
    return ws


class TestSubscribeStateReported:
    async def test_accepted(self):
        client = HAClient("ws://ha.local", "tok")
        client._msg_id = 4
        client._ws = _ws_with([{"type": "result", "id": 5, "success": True}])
        await client._subscribe_state_reported()
        assert client.state_reported_supported is True
        payload = client._ws.send_json.call_args[0][0]
        assert payload == {"id": 5, "type": "subscribe_events", "event_type": "state_reported"}

    async def test_refused_is_recorded_and_logged_once(self, caplog):
        client = HAClient("ws://ha.local", "tok")
        refusal = {"type": "result", "id": 1, "success": False, "error": {"code": "unauthorized"}}
        client._ws = _ws_with([refusal])
        with caplog.at_level(logging.INFO, logger="backend.ha_client"):
            await client._subscribe_state_reported()
        assert client.state_reported_supported is False
        assert sum("declined the state_reported" in r.message for r in caplog.records) == 1

        # A reconnect that is refused again does not repeat the message.
        caplog.clear()
        client._ws = _ws_with([{**refusal, "id": 2}])
        with caplog.at_level(logging.INFO, logger="backend.ha_client"):
            await client._subscribe_state_reported()
        assert client.state_reported_supported is False
        assert not any("declined the state_reported" in r.message for r in caplog.records)

    async def test_events_before_the_result_are_dispatched(self):
        client = HAClient("ws://ha.local", "tok")
        seen: list[str] = []

        async def listener(entity_id: str, _state: dict) -> None:
            seen.append(entity_id)

        client.subscribe("sensor.a", listener)
        event = {
            "type": "event",
            "event": {
                "event_type": "state_changed",
                "data": {"entity_id": "sensor.a", "new_state": {"state": "1"}},
            },
        }
        client._ws = _ws_with(
            [
                event,
                {"type": "result", "id": 99, "success": True},
                {"type": "result", "id": 1, "success": True},
            ]
        )
        await client._subscribe_state_reported()
        await asyncio.sleep(0)
        assert client.state_reported_supported is True
        assert seen == ["sensor.a"]
        assert client.get_state("sensor.a") == {"state": "1"}

    async def test_silent_peer_counts_as_refused(self):
        client = HAClient("ws://ha.local", "tok")
        ws = MagicMock()
        ws.send_json = AsyncMock()

        async def slow():
            await asyncio.sleep(0.3)
            return {"type": "result", "id": 1, "success": True}

        ws.receive_json = slow
        client._ws = ws
        with patch("backend.ha_client._HANDSHAKE_TIMEOUT_S", 0.05):
            await client._subscribe_state_reported()
        assert client.state_reported_supported is False

    async def test_deadline_already_passed_counts_as_refused(self):
        client = HAClient("ws://ha.local", "tok")
        client._ws = _ws_with([])
        with patch("backend.ha_client._HANDSHAKE_TIMEOUT_S", 0):
            await client._subscribe_state_reported()
        assert client.state_reported_supported is False
        client._ws.receive_json.assert_not_called()


class TestStateReportedEvents:
    def _event(self, data: dict, time_fired: str | None = None) -> dict:
        event: dict = {"event_type": "state_reported", "data": data}
        if time_fired is not None:
            event["time_fired"] = time_fired
        return {"type": "event", "event": event}

    async def test_new_state_stamp_moves_last_reported_only(self):
        client = HAClient("ws://ha.local", "tok")
        old = {"state": "70", "last_updated": _iso(200), "last_reported": _iso(200)}
        client._state_cache["sensor.t"] = old
        listener = AsyncMock()
        client.subscribe("sensor.t", listener)
        stamp = _iso(0)
        await client._dispatch(
            self._event({"entity_id": "sensor.t", "new_state": {"last_reported": stamp}})
        )
        cached = client.get_state("sensor.t")
        assert cached["last_reported"] == stamp
        assert cached["state"] == "70"
        assert cached["last_updated"] == old["last_updated"]
        listener.assert_not_called()

    async def test_time_fired_is_the_fallback_stamp(self):
        client = HAClient("ws://ha.local", "tok")
        client._state_cache["sensor.t"] = {"state": "70"}
        stamp = _iso(0)
        await client._dispatch(self._event({"entity_id": "sensor.t"}, time_fired=stamp))
        assert client.get_state("sensor.t")["last_reported"] == stamp

    async def test_unknown_entity_and_bad_stamp_are_ignored(self):
        client = HAClient("ws://ha.local", "tok")
        await client._dispatch(self._event({"entity_id": "sensor.nope"}, time_fired=_iso(0)))
        assert client.get_state("sensor.nope") is None

        client._state_cache["sensor.t"] = {"state": "70"}
        await client._dispatch(self._event({"entity_id": "sensor.t"}, time_fired="not-a-time"))
        assert client.get_state("sensor.t") == {"state": "70"}


class _Resp:
    def __init__(self, payload: list[dict]) -> None:
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def raise_for_status(self) -> None:
        return None

    async def json(self):
        return self._payload


class TestRefreshStates:
    async def test_newer_or_equal_snapshots_replace_and_older_ones_do_not(self):
        client = HAClient("ws://ha.local", "tok")
        client._session = MagicMock()
        client._state_cache = {
            "sensor.newer": {"state": "1", "last_updated": _iso(10)},
            "sensor.older": {"state": "live", "last_updated": _iso(1)},
            "sensor.unstamped_cache": {"state": "x"},
            "sensor.unstamped_snapshot": {"state": "keep", "last_updated": _iso(5)},
        }
        snapshot = [
            {
                "entity_id": "sensor.newer",
                "state": "2",
                "last_updated": _iso(10),
                "last_reported": _iso(0),
            },
            {"entity_id": "sensor.older", "state": "stale", "last_updated": _iso(30)},
            {"entity_id": "sensor.unstamped_cache", "state": "y", "last_updated": _iso(2)},
            {"entity_id": "sensor.unstamped_snapshot", "state": "lost"},
            {"entity_id": "sensor.brand_new", "state": "3"},
        ]
        client._session.get = MagicMock(return_value=_Resp(snapshot))
        assert await client.refresh_states() == 3
        assert client.get_state("sensor.newer")["state"] == "2"
        assert client.get_state("sensor.older")["state"] == "live"
        assert client.get_state("sensor.unstamped_cache")["state"] == "y"
        assert client.get_state("sensor.unstamped_snapshot")["state"] == "keep"
        assert client.get_state("sensor.brand_new")["state"] == "3"
        url = client._session.get.call_args[0][0]
        assert url == "http://ha.local/api/states"


class TestConnectSubscribesToBoth:
    async def test_connect_runs_both_subscriptions(self):
        client = HAClient("http://ha.local", "tok")
        ws = MagicMock()

        class _Ctx:
            async def __aenter__(self_inner):
                return ws

            async def __aexit__(self_inner, *exc):
                return False

        client._session = MagicMock()
        client._session.ws_connect = MagicMock(return_value=_Ctx())
        order: list[str] = []
        client._handshake = AsyncMock()
        client.fetch_states = AsyncMock(return_value=[])
        client.get_temperature_unit = AsyncMock(return_value="F")
        client._subscribe_state_changed = AsyncMock(side_effect=lambda: order.append("changed"))
        client._subscribe_state_reported = AsyncMock(side_effect=lambda: order.append("reported"))
        client._read_loop = AsyncMock()
        await client._connect()
        assert order == ["changed", "reported"]


@pytest.mark.parametrize("supported", [True, None])
async def test_scheduler_skips_refresh_when_not_needed(supported):
    from backend.scheduler import Scheduler

    sched = Scheduler.__new__(Scheduler)
    sched._ha = MagicMock()
    sched._ha.state_reported_supported = supported
    sched._ha.is_connected = True
    sched._ha.refresh_states = AsyncMock()
    await sched._refresh_reported_states()
    sched._ha.refresh_states.assert_not_called()


async def test_scheduler_skips_refresh_while_disconnected():
    from backend.scheduler import Scheduler

    sched = Scheduler.__new__(Scheduler)
    sched._ha = MagicMock()
    sched._ha.state_reported_supported = False
    sched._ha.is_connected = False
    sched._ha.refresh_states = AsyncMock()
    await sched._refresh_reported_states()
    sched._ha.refresh_states.assert_not_called()


async def test_scheduler_refreshes_when_subscription_refused(caplog):
    from backend.scheduler import Scheduler

    sched = Scheduler.__new__(Scheduler)
    sched._ha = MagicMock()
    sched._ha.state_reported_supported = False
    sched._ha.is_connected = True
    sched._ha.refresh_states = AsyncMock(return_value=4)
    await sched._refresh_reported_states()
    sched._ha.refresh_states.assert_awaited_once()

    sched._ha.refresh_states = AsyncMock(side_effect=RuntimeError("boom"))
    with caplog.at_level(logging.WARNING, logger="backend.scheduler"):
        await sched._refresh_reported_states()
    assert any("Could not refresh HA states" in r.message for r in caplog.records)


class TestGetRegistries:
    async def test_collects_all_four_and_degrades_optional_ones(self):
        client = HAClient("ws://ha.local", "tok")
        answers = {
            "config/area_registry/list": [{"area_id": "a"}],
            "config/floor_registry/list": None,
            "config/device_registry/list": RuntimeError("unknown command"),
            "config/entity_registry/list": [{"entity_id": "sensor.x"}],
        }

        async def fake_send(payload):
            value = answers[payload["type"]]
            if isinstance(value, Exception):
                raise value
            return value

        client._send = fake_send
        result = await client.get_registries()
        assert result == {
            "areas": [{"area_id": "a"}],
            "floors": [],
            "devices": [],
            "entities": [{"entity_id": "sensor.x"}],
        }

    async def test_area_failure_propagates(self):
        client = HAClient("ws://ha.local", "tok")
        client._send = AsyncMock(side_effect=RuntimeError("HA not connected"))
        with pytest.raises(RuntimeError):
            await client.get_registries()

    async def test_empty_area_reply_is_an_empty_list(self):
        client = HAClient("ws://ha.local", "tok")
        client._send = AsyncMock(return_value=None)
        assert await client.get_registries() == {
            "areas": [],
            "floors": [],
            "devices": [],
            "entities": [],
        }
