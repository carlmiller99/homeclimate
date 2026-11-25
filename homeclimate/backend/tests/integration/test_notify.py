"""Notifications: which events are sent, once each, and the daily summary."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import db, notify, tz
from backend.models import CycleLog

pytestmark = pytest.mark.asyncio

SERVICE = "notify.mobile_app_phone"
NOW = datetime(2026, 1, 10, 13, 5, tzinfo=UTC)


def _sent(fake_ha) -> list[tuple[str, str]]:
    return [
        (c.data["title"], c.data["message"])
        for c in fake_ha.calls
        if c.domain == "notify" and c.service == "mobile_app_phone"
    ]


async def _on(client, **more):
    resp = await client.put(
        "/api/notifications/settings", json={"enabled": True, "service": SERVICE, **more}
    )
    assert resp.status == 200, await resp.text()
    return (await resp.json())["settings"]


async def _log(client, level, category, message):
    scheduler = client.app["scheduler"]
    await scheduler._event_logger.log(level, category, message)
    await scheduler.notifier.drain()  # sending is handed off; wait for it here


async def test_off_by_default_and_nothing_is_sent(client, fake_ha):
    snap = await (await client.get("/api/notifications")).json()
    assert snap["settings"] == {
        "enabled": False,
        "service": "",
        "level": "warning",
        "categories": ["engine", "fireplace"],
        "daily_summary": False,
        "summary_hour": 7,
        "in_dev_mode": False,
    }
    assert [c["id"] for c in snap["categories"]] == list(notify.CATEGORIES)
    assert snap["last_send_failed"] is False
    await _log(client, "error", "engine", "Something broke")
    # Switched on but with nowhere to send, still nothing.
    await client.put("/api/notifications/settings", json={"enabled": True})
    await _log(client, "error", "engine", "Something else broke")
    assert _sent(fake_ha) == []


async def test_chosen_warnings_and_errors_are_sent_once_each(client, fake_ha):
    await _on(client)
    await _log(client, "warning", "engine", "Bunk Room is past a safety limit")
    await _log(client, "error", "engine", "Tick failed")
    await _log(client, "info", "engine", "Cycle started")  # not a problem
    await _log(client, "warning", "forecast", "Forecast fetch failed")  # not chosen
    await _log(client, "warning", "api", "Not a category that notifies")
    await _log(client, "warning", "engine", "Bunk Room is past a safety limit")  # said already
    assert _sent(fake_ha) == [
        ("HomeClimate", "Bunk Room is past a safety limit"),
        ("HomeClimate: problem", "Tick failed"),
    ]
    # Errors only.
    await _on(client, level="error")
    await _log(client, "warning", "engine", "A different warning")
    assert len(_sent(fake_ha)) == 2
    # The same message is said again once six hours have passed.
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    notifier = scheduler.notifier
    args = {"level": "error", "category": "engine", "message": "Tick failed"}
    later = datetime.now(UTC) + timedelta(hours=5)
    assert not await notifier.on_event(conn, fake_ha, dev_mode=False, now=later, **args)
    later += timedelta(hours=2)
    assert await notifier.on_event(conn, fake_ha, dev_mode=False, now=later, **args)
    # A very long message is cut short.
    await notifier.on_event(
        conn,
        fake_ha,
        level="error",
        category="engine",
        message="x" * 500,
        dev_mode=False,
        now=later,
    )
    await notifier.drain()
    assert len(_sent(fake_ha)[-1][1]) == notify.MAX_LEN


async def test_the_same_thing_with_different_numbers_is_said_once(client, fake_ha):
    await _on(client)
    for left in ("5.0", "4.0", "3.0", "2.0"):
        await _log(client, "warning", "engine", f"Compressor off-time lockout: deferred {left} min")
    assert _sent(fake_ha) == [("HomeClimate", "Compressor off-time lockout: deferred 5.0 min")]


async def test_a_bad_night_cannot_flood_a_phone_but_an_error_still_gets_through(client, fake_ha):
    await _on(client)
    for name in "abcdefghij":
        await _log(client, "warning", "engine", f"Problem {name}")
    sent = _sent(fake_ha)
    assert len(sent) == notify.MAX_AN_HOUR + 1
    assert sent[-1][1] == "More is happening than can be sent. See the log in HomeClimate."
    # An error has an allowance of its own: warnings can never crowd it out.
    await _log(client, "error", "engine", "Safety protection could not act")
    assert _sent(fake_ha)[-1] == ("HomeClimate: problem", "Safety protection could not act")
    # An hour on, warnings flow again.
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    later = datetime.now(UTC) + timedelta(hours=1, minutes=1)
    assert await scheduler.notifier.on_event(
        conn,
        fake_ha,
        level="warning",
        category="engine",
        message="Later",
        dev_mode=False,
        now=later,
    )
    await scheduler.notifier.drain()


async def test_a_slow_home_assistant_never_holds_up_whatever_logged_the_event(
    client, fake_ha, monkeypatch
):
    import asyncio

    await _on(client)
    release = asyncio.Event()

    async def slow(*_a, **_k):
        await release.wait()
        return {}

    monkeypatch.setattr(fake_ha, "call_service", slow)
    scheduler = client.app["scheduler"]
    # log() returns although the send has not finished.
    await asyncio.wait_for(scheduler._event_logger.log("warning", "engine", "Problem"), 1)
    assert scheduler.notifier._tasks
    release.set()
    await scheduler.notifier.drain()
    assert not scheduler.notifier._tasks


async def test_a_message_that_could_not_be_sent_is_tried_again_and_does_not_count(
    client, fake_ha, monkeypatch
):
    await _on(client)
    real = fake_ha.call_service

    async def refuse(*_a, **_k):
        raise RuntimeError("timeout")

    monkeypatch.setattr(fake_ha, "call_service", refuse)
    await _log(client, "warning", "engine", "Problem")
    notifier = client.app["scheduler"].notifier
    assert notifier._sent == {} and notifier._recent == [] and notifier.last_error
    monkeypatch.setattr(fake_ha, "call_service", real)
    await _log(client, "warning", "engine", "Problem")
    assert _sent(fake_ha) == [("HomeClimate", "Problem")]


async def test_nothing_is_sent_in_dev_mode_unless_asked_or_while_disconnected(client, fake_ha):
    await _on(client)
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    args = {"level": "warning", "category": "engine", "now": NOW}
    assert not await scheduler.notifier.on_event(conn, fake_ha, message="a", dev_mode=True, **args)
    await _on(client, in_dev_mode=True)
    assert await scheduler.notifier.on_event(conn, fake_ha, message="a", dev_mode=True, **args)
    fake_ha._connected.clear()
    try:
        assert not await scheduler.notifier.on_event(
            conn, fake_ha, message="b", dev_mode=False, **args
        )
        assert not await scheduler.notifier.on_event(
            conn, None, message="c", dev_mode=False, **args
        )
        await client.put("/api/notifications/settings", json={"daily_summary": True})
        assert not await scheduler.notifier.daily(conn, fake_ha, dev_mode=False, now=NOW)
        resp = await client.post("/api/notifications/test")
        assert (resp.status, (await resp.json())["error"]) == (
            400,
            "Home Assistant is not connected, so nothing can be sent right now",
        )
    finally:
        fake_ha._connected.set()
    await scheduler.notifier.drain()


async def test_a_failed_send_is_reported_and_never_escapes(client, fake_ha, monkeypatch, caplog):
    await _on(client)

    async def refuse(*_a, **_k):
        raise RuntimeError("no such service")

    monkeypatch.setattr(fake_ha, "call_service", refuse)
    await _log(client, "warning", "engine", "Problem")
    assert "Could not send a notification through notify.mobile_app_phone" in caplog.text
    snap = await (await client.get("/api/notifications")).json()
    assert snap["last_send_failed"] is True
    resp = await client.post("/api/notifications/test")
    assert (resp.status, (await resp.json())["error"]) == (
        400,
        "Home Assistant did not accept the notification. Check the service name.",
    )
    # Settings that cannot even be read do not escape either.
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()

    async def broken(*_a, **_k):
        raise RuntimeError("db gone")

    monkeypatch.setattr(notify, "get_settings", broken)
    assert not await scheduler.notifier.on_event(
        conn, fake_ha, level="error", category="engine", message="m", dev_mode=False, now=NOW
    )
    assert not await scheduler.notifier.daily(conn, fake_ha, dev_mode=False, now=NOW)
    # A listener that fails never disturbs logging.
    scheduler._event_logger.set_listener(broken)
    await _log(client, "warning", "engine", "still logged")


async def test_the_test_button_sends_now(client, fake_ha):
    resp = await client.post("/api/notifications/test")
    assert (resp.status, (await resp.json())["error"]) == (400, "Choose a notify service first")
    await client.put("/api/notifications/settings", json={"service": SERVICE})  # not even enabled
    resp = await client.post("/api/notifications/test")
    assert resp.status == 200 and (await resp.json())["last_send_failed"] is False
    assert _sent(fake_ha) == [("HomeClimate", "This is a test notification from HomeClimate.")]


async def test_the_daily_summary_is_sent_once_at_the_chosen_hour(client, fake_ha):
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    # Yesterday (house time): two heating cycles of 30 and 45 minutes, and a warning.
    for start, minutes in ((datetime(2026, 1, 9, 14, 0), 30), (datetime(2026, 1, 9, 20, 0), 45)):
        cycle = CycleLog.create(thermostat_entity_id="climate.x", mode="heating", rooms_json="{}")
        cycle.started_at = start.replace(tzinfo=UTC)
        cycle.ended_at = (start + timedelta(minutes=minutes)).replace(tzinfo=UTC)
        await db.insert_cycle_log(conn, cycle)
    await db.insert_event_log(conn, "2026-01-09T15:00:00", "warning", "engine", "w", None)
    await db.insert_event_log(conn, "2026-01-08T15:00:00", "error", "engine", "old", None)

    notifier = scheduler.notifier
    await _on(client, daily_summary=True, summary_hour=tz.to_local(NOW).hour)
    early = NOW - timedelta(hours=2)
    assert not await notifier.daily(conn, fake_ha, dev_mode=False, now=early)
    assert not await notifier.daily(conn, fake_ha, dev_mode=True, now=NOW)
    assert await notifier.daily(conn, fake_ha, dev_mode=False, now=NOW)
    await notifier.drain()
    assert _sent(fake_ha)[-1] == (
        "HomeClimate: yesterday",
        "Yesterday heating ran 2 times for 1 h 15 min. The log has 1 warning.",
    )
    # Not again that day, even after a restart; again the next day.
    assert not await notifier.daily(conn, fake_ha, dev_mode=False, now=NOW + timedelta(minutes=1))
    scheduler._notifier = notify.Notifier()
    assert not await scheduler.notifier.daily(conn, fake_ha, dev_mode=False, now=NOW)
    # If the chosen hour was missed (HomeClimate was down), it goes later that day.
    late = NOW + timedelta(days=1, hours=3)
    if tz.to_local(late).date() == tz.to_local(NOW + timedelta(days=1)).date():
        assert await scheduler.notifier.daily(conn, fake_ha, dev_mode=False, now=late)
        await scheduler.notifier.drain()
        assert _sent(fake_ha)[-1][1] == "Yesterday nothing ran. No warnings."
    # Switched off, nothing is sent.
    await _on(client, daily_summary=False)
    assert not await scheduler.notifier.daily(
        conn, fake_ha, dev_mode=False, now=NOW + timedelta(days=2)
    )


async def test_a_summary_that_could_not_be_sent_is_tried_a_few_times(client, fake_ha, monkeypatch):
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    await _on(client, daily_summary=True, summary_hour=tz.to_local(NOW).hour)

    async def refuse(*_a, **_k):
        raise RuntimeError("timeout")

    monkeypatch.setattr(fake_ha, "call_service", refuse)
    notifier = scheduler.notifier
    for minute in range(notify.SUMMARY_TRIES):
        assert await notifier.daily(
            conn, fake_ha, dev_mode=False, now=NOW + timedelta(minutes=minute)
        )
        await notifier.drain()
    # After that it gives up for the day rather than try every minute.
    assert not await notifier.daily(conn, fake_ha, dev_mode=False, now=NOW + timedelta(minutes=9))
    assert await db.get_system_setting(conn, "notify_summary_sent", "") == ""


async def test_the_summary_counts_only_the_part_of_a_cycle_inside_yesterday(client):
    conn = await client.app["scheduler"].get_db()
    local_midnight = tz.to_local(NOW).replace(hour=0, minute=0, second=0, microsecond=0)
    # One that began the day before and ran an hour into yesterday; one still running
    # since 23:00 yesterday.
    crossing = CycleLog.create(thermostat_entity_id="climate.x", mode="heating", rooms_json="{}")
    crossing.started_at = (local_midnight - timedelta(days=1, hours=1)).astimezone(UTC)
    crossing.ended_at = (local_midnight - timedelta(days=1) + timedelta(hours=1)).astimezone(UTC)
    await db.insert_cycle_log(conn, crossing)
    running = CycleLog.create(thermostat_entity_id="climate.x", mode="heating", rooms_json="{}")
    running.started_at = (local_midnight - timedelta(hours=1)).astimezone(UTC)
    await db.insert_cycle_log(conn, running)
    assert await notify.summary(conn, now=NOW) == (
        "Yesterday heating ran 2 times for 2 h 0 min. No warnings."
    )


async def test_the_summary_words(client):
    conn = await client.app["scheduler"].get_db()
    for mode, start, minutes in (
        ("heating", datetime(2026, 1, 9, 14, 0), 1),
        ("cooling", datetime(2026, 1, 9, 16, 0), 20),
    ):
        cycle = CycleLog.create(thermostat_entity_id="climate.x", mode=mode, rooms_json="{}")
        cycle.started_at = start.replace(tzinfo=UTC)
        cycle.ended_at = (start + timedelta(minutes=minutes)).replace(tzinfo=UTC)
        await db.insert_cycle_log(conn, cycle)
    for level in ("error", "error", "warning", "warning"):
        await db.insert_event_log(conn, "2026-01-09T15:00:00", level, "engine", "x", None)
    assert await notify.summary(conn, now=NOW) == (
        "Yesterday heating ran 1 time for 1 min and cooling ran 1 time for 20 min."
        " The log has 2 errors and 2 warnings."
    )
    await conn.execute("DELETE FROM event_log WHERE level = 'warning'")
    await conn.execute(
        "DELETE FROM event_log WHERE level = 'error' AND id NOT IN"
        " (SELECT MIN(id) FROM event_log WHERE level = 'error')"
    )
    await conn.commit()
    assert (await notify.summary(conn, now=NOW)).endswith("The log has 1 error.")


async def test_settings_are_validated_with_fixed_messages(client):
    for body, message in (
        ({"enabled": "yes"}, "enabled, daily_summary and in_dev_mode must be true or false"),
        ({"service": "light.kitchen"}, notify.BAD_SERVICE),
        ({"service": "notify.bad name!"}, notify.BAD_SERVICE),
        ({"service": "notify.Phone"}, notify.BAD_SERVICE),
        ({"service": "notify.send_message"}, notify.BAD_SERVICE),
        ({"service": 5}, notify.BAD_SERVICE),
        ({"level": "info"}, "level must be warning or error"),
        ({"categories": ["engine", "nope"]}, "categories must be a list of known categories"),
        ({"categories": "engine"}, "categories must be a list of known categories"),
        ({"summary_hour": 24}, "summary_hour must be a whole hour from 0 to 23"),
        ({"summary_hour": True}, "summary_hour must be a whole hour from 0 to 23"),
        ({"colour": "red"}, "Unknown notification setting"),
    ):
        resp = await client.put("/api/notifications/settings", json=body)
        assert (resp.status, (await resp.json())["error"]) == (400, str(message)), body
    settings = await _on(
        client, categories=["system", "engine"], summary_hour=21, level="error", service=None
    )
    assert (settings["categories"], settings["summary_hour"], settings["service"]) == (
        ["engine", "system"],
        21,
        "",
    )
    # A stored hour that makes no sense reads as the default.
    conn = await client.app["scheduler"].get_db()
    await db.set_system_setting(conn, "notify_summary_hour", "99")
    assert (await notify.get_settings(conn))["summary_hour"] == 7
