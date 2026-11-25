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
    await client.app["scheduler"]._event_logger.log(level, category, message)


async def test_off_by_default_and_nothing_is_sent(client, fake_ha):
    snap = await (await client.get("/api/notifications")).json()
    assert snap["settings"] == {
        "enabled": False,
        "service": "",
        "level": "warning",
        "categories": ["engine", "ha", "fireplace"],
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
    await _log(client, "error", "ha", "Home Assistant disconnected")
    await _log(client, "info", "engine", "Cycle started")  # not a problem
    await _log(client, "warning", "shades", "A shade did not move")  # not chosen
    await _log(client, "warning", "api", "Not a category that notifies")
    await _log(client, "warning", "engine", "Bunk Room is past a safety limit")  # said already
    assert _sent(fake_ha) == [
        ("HomeClimate", "Bunk Room is past a safety limit"),
        ("HomeClimate: problem", "Home Assistant disconnected"),
    ]
    # Errors only.
    await _on(client, level="error")
    await _log(client, "warning", "engine", "A different warning")
    assert len(_sent(fake_ha)) == 2
    # The same message is said again once six hours have passed.
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    notifier = scheduler.notifier
    args = {"level": "error", "category": "ha", "message": "Home Assistant disconnected"}
    later = datetime.now(UTC) + timedelta(hours=5)
    assert not await notifier.on_event(conn, fake_ha, dev_mode=False, now=later, **args)
    later += timedelta(hours=2)
    assert await notifier.on_event(conn, fake_ha, dev_mode=False, now=later, **args)
    # A very long message is cut short.
    await notifier.on_event(
        conn, fake_ha, level="error", category="ha", message="x" * 500, dev_mode=False, now=later
    )
    assert len(_sent(fake_ha)[-1][1]) == notify.MAX_LEN


async def test_a_bad_night_cannot_flood_a_phone(client, fake_ha):
    await _on(client)
    for i in range(10):
        await _log(client, "warning", "engine", f"Problem {i}")
    sent = _sent(fake_ha)
    assert len(sent) == notify.MAX_AN_HOUR + 1
    assert sent[-1][1] == "More is happening than can be sent. See the log in HomeClimate."
    # An hour on, messages flow again.
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
    finally:
        fake_ha._connected.set()


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
        conn, fake_ha, level="error", category="ha", message="m", dev_mode=False, now=NOW
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
    assert _sent(fake_ha)[-1] == (
        "HomeClimate: yesterday",
        "Yesterday heating ran 2 times for 1 h 15 min. The log has 1 warning.",
    )
    # Not again that day, even after a restart; again the next day.
    assert not await notifier.daily(conn, fake_ha, dev_mode=False, now=NOW + timedelta(minutes=1))
    scheduler._notifier = notify.Notifier()
    assert not await scheduler.notifier.daily(conn, fake_ha, dev_mode=False, now=NOW)
    assert await scheduler.notifier.daily(
        conn, fake_ha, dev_mode=False, now=NOW + timedelta(days=1)
    )
    assert _sent(fake_ha)[-1][1] == "Yesterday nothing ran. No warnings."
    # Switched off, nothing is sent.
    await _on(client, daily_summary=False)
    assert not await scheduler.notifier.daily(
        conn, fake_ha, dev_mode=False, now=NOW + timedelta(days=2)
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
        client, categories=["shades", "engine"], summary_hour=21, level="error", service=None
    )
    assert (settings["categories"], settings["summary_hour"], settings["service"]) == (
        ["engine", "shades"],
        21,
        "",
    )
    # A stored hour that makes no sense reads as the default.
    conn = await client.app["scheduler"].get_db()
    await db.set_system_setting(conn, "notify_summary_hour", "99")
    assert (await notify.get_settings(conn))["summary_hour"] == 7
