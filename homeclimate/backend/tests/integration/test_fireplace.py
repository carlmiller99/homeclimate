"""Fireplaces: configuration, lit and cool-down tracking, and setting rooms aside."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import fireplace, learning

pytestmark = pytest.mark.asyncio

T1 = "climate.great"
T2 = "climate.up"
RELAY = "switch.fireplace_relay"
NOW = datetime(2026, 1, 5, 20, 0, tzinfo=UTC)


async def _room(client, name: str, thermostat: str) -> str:
    resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": thermostat})
    assert resp.status == 201, await resp.text()
    return str((await resp.json())["id"])


@pytest.fixture
async def house(client, fake_ha):
    fake_ha.seed_state(T1, "heat", {"current_temperature": 68, "hvac_action": "idle"})
    fake_ha.seed_state(T2, "heat", {"current_temperature": 68, "hvac_action": "idle"})
    fake_ha.seed_state(RELAY, "off", {})
    return {
        "great": await _room(client, "Great Room", T1),
        "kitchen": await _room(client, "Kitchen", T1),
        "loft": await _room(client, "Loft", T2),
    }


async def _add(client, house, **over) -> dict:
    body = {
        "name": "Great Room Fireplace",
        "entity_id": RELAY,
        "room_ids": [house["great"], house["loft"]],
        **over,
    }
    resp = await client.post("/api/fireplaces", json=body)
    assert resp.status == 201, await resp.text()
    found: dict = (await resp.json())["fireplaces"][0]
    return found


async def _one(client) -> dict:
    found: dict = (await (await client.get("/api/fireplaces")).json())["fireplaces"][0]
    return found


async def _events(client) -> list[str]:
    events = await (await client.get("/api/logs/events?category=fireplace")).json()
    return sorted(e["message"] for e in events)


async def test_none_by_default(client):
    assert await (await client.get("/api/fireplaces")).json() == {"fireplaces": []}
    snap = await (await client.get("/api/smart-control")).json()
    assert snap["fireplace_rooms"] == []


async def test_a_new_fireplace_watches_only(client, fake_ha, house):
    f = await _add(client, house)
    assert f["control"] == "watch" and f["cooldown_min"] == 60
    assert f["room_ids"] == sorted([house["great"], house["loft"]])
    assert (f["state"], f["lit_since"], f["cooling_until"], f["setting_aside"]) == (
        "out",
        None,
        None,
        False,
    )
    await fake_ha.set_entity_state(RELAY, "on")
    f = await _one(client)
    assert f["state"] == "lit" and f["lit_since"] is not None
    assert f["setting_aside"] is False  # watching changes nothing
    scheduler = client.app["scheduler"]
    assert scheduler._pause_for(T1) == (False, frozenset())
    assert await _events(client) == ["Great Room Fireplace is lit (watching only)"]


async def test_when_on_its_rooms_are_set_aside_through_the_cool_down(client, fake_ha, house):
    f = await _add(client, house, control="on", cooldown_min=30)
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    monitor = scheduler.fireplaces
    assert scheduler._pause_for(T1) == (False, frozenset())

    await fake_ha.set_entity_state(RELAY, "on")
    aside = frozenset({house["great"], house["loft"]})
    assert scheduler._pause_for(T1) == (False, aside)
    assert scheduler._pause_for(T2) == (False, aside)
    snap = await (await client.get("/api/smart-control")).json()
    assert sorted(r["room_id"] for r in snap["fireplace_rooms"]) == sorted(aside)
    assert snap["fireplace_rooms"][0]["fireplace"] == "Great Room Fireplace"
    assert (await _one(client))["setting_aside"] is True

    # Out: still set aside while it cools down.
    await fake_ha.set_entity_state(RELAY, "off")
    f = await _one(client)
    assert (f["state"], f["setting_aside"], f["lit_since"]) == ("cooling", True, None)
    assert f["cooling_until"] is not None
    assert scheduler._pause_for(T1)[1] == aside

    # After the cool-down the rooms are back.
    assert await monitor.evaluate(
        conn, fake_ha.get_state, datetime.now(UTC) + timedelta(minutes=31)
    )
    assert scheduler._pause_for(T1) == (False, frozenset())
    assert monitor.statuses()[0].state == "out"


async def test_changes_are_logged_once_each(client, fake_ha, house):
    await _add(client, house, control="on", cooldown_min=0)
    await fake_ha.set_entity_state(RELAY, "on")
    await client.app["scheduler"]._evaluate_fireplaces()  # no change: no second line
    await fake_ha.set_entity_state(RELAY, "off")
    assert await _events(client) == [
        "Great Room Fireplace has cooled down; Great Room, Loft back to normal",
        "Great Room Fireplace is lit; Great Room, Loft set aside",
    ]


async def test_a_signal_that_stops_reporting(client, fake_ha, house):
    await _add(client, house, control="on", cooldown_min=45)
    await fake_ha.set_entity_state(RELAY, "unavailable")
    f = await _one(client)
    assert (f["state"], f["setting_aside"]) == ("unknown", False)
    # Lit, then the relay drops off: treated as cooling, not as out.
    await fake_ha.set_entity_state(RELAY, "on")
    await fake_ha.set_entity_state(RELAY, "unavailable")
    f = await _one(client)
    assert (f["state"], f["setting_aside"]) == ("cooling", True)
    messages = await _events(client)
    assert "Great Room Fireplace: its signal is not reporting" in messages
    assert "Great Room Fireplace is out; cooling down for 45 min" in messages


async def test_the_cool_down_survives_a_restart(client, fake_ha, house):
    await _add(client, house, control="on", cooldown_min=60)
    await fake_ha.set_entity_state(RELAY, "on")
    await fake_ha.set_entity_state(RELAY, "off")
    scheduler = client.app["scheduler"]
    scheduler._fireplaces = fireplace.FireplaceMonitor()  # as after a restart
    assert scheduler._pause_for(T1) == (False, frozenset())
    await scheduler._evaluate_fireplaces()
    assert scheduler._pause_for(T1)[1] == frozenset({house["great"], house["loft"]})


async def test_thermostat_style_signals_are_lit_only_while_heating():
    assert fireplace.is_lit(None) is None
    assert fireplace.is_lit({"state": "unknown"}) is None
    assert fireplace.is_lit({"state": "on"}) is True
    assert fireplace.is_lit({"state": "off"}) is False
    assert fireplace.is_lit({"state": "heat"}) is True
    assert fireplace.is_lit({"state": "heat", "attributes": {"hvac_action": "idle"}}) is False
    assert fireplace.is_lit({"state": "heat", "attributes": {"hvac_action": "heating"}}) is True


async def test_editing_and_removing(client, fake_ha, house):
    f = await _add(client, house, control="on")
    await fake_ha.set_entity_state(RELAY, "on")
    url = f"/api/fireplaces/{f['id']}"
    resp = await client.put(url, json={"name": " Hearth ", "cooldown_min": 0, "control": "off"})
    got = (await resp.json())["fireplaces"][0]
    assert (got["name"], got["cooldown_min"], got["control"]) == ("Hearth", 0, "off")
    assert got["setting_aside"] is False
    assert client.app["scheduler"]._pause_for(T1) == (False, frozenset())

    # A different signal forgets when the old one was last lit.
    fake_ha.seed_state("binary_sensor.flame", "off", {})
    resp = await client.put(
        url, json={"entity_id": "binary_sensor.flame", "cooldown_min": 240, "control": "on"}
    )
    got = (await resp.json())["fireplaces"][0]
    assert (got["entity_id"], got["state"]) == ("binary_sensor.flame", "out")
    resp = await client.put(url, json={"room_ids": [house["kitchen"]]})
    assert (await resp.json())["fireplaces"][0]["room_ids"] == [house["kitchen"]]
    # Keeping its own name is not a clash.
    assert (await client.put(url, json={"name": "hearth"})).status == 200

    assert (await client.put("/api/fireplaces/nope", json={"name": "x"})).status == 404
    assert (await client.delete("/api/fireplaces/nope")).status == 404
    resp = await client.delete(url)
    assert await resp.json() == {"fireplaces": []}
    assert client.app["scheduler"].fireplaces.entities == frozenset()


async def test_deleting_a_room_takes_it_off_the_fireplace(client, house):
    f = await _add(client, house)
    await client.post("/api/rooms", json={"name": "Loft 2", "thermostat_entity_id": T2})
    assert (await client.delete(f"/api/rooms/{house['loft']}")).status in (200, 204)
    assert (await _one(client))["room_ids"] == [house["great"]]
    assert f["id"]


async def test_validation_uses_fixed_messages(client, house):
    good = {"name": "Hearth", "entity_id": RELAY, "room_ids": [house["great"]]}
    for patch, message in (
        ({"name": ""}, "Give the fireplace a name of up to 60 characters"),
        ({"name": "x" * 61}, "Give the fireplace a name of up to 60 characters"),
        ({"name": 5}, "Give the fireplace a name of up to 60 characters"),
        ({"entity_id": "sensor.temp"}, fireplace.BAD_ENTITY),
        ({"entity_id": "switch."}, fireplace.BAD_ENTITY),
        ({"entity_id": 5}, fireplace.BAD_ENTITY),
        ({"room_ids": []}, "Choose at least one room the fireplace warms"),
        ({"room_ids": "all"}, "Choose at least one room the fireplace warms"),
        ({"room_ids": [5]}, "Choose at least one room the fireplace warms"),
        ({"room_ids": ["nope"]}, "One of those rooms does not exist"),
        ({"cooldown_min": 241}, "Cool-down must be a whole number of minutes from 0 to 240"),
        ({"cooldown_min": True}, "Cool-down must be a whole number of minutes from 0 to 240"),
        ({"control": "auto"}, "control must be off, watch or on"),
        ({"colour": "red"}, "Unknown fireplace field"),
    ):
        resp = await client.post("/api/fireplaces", json={**good, **patch})
        assert resp.status == 400, patch
        assert (await resp.json())["error"] == message
    resp = await client.post("/api/fireplaces", json={"name": "Hearth"})
    assert (await resp.json())["error"] == (
        "A fireplace needs a name, an entity and at least one room"
    )
    assert (await client.post("/api/fireplaces", json=good)).status == 201
    resp = await client.post("/api/fireplaces", json={**good, "name": "hearth"})
    assert (await resp.json())["error"] == "Another fireplace already has that name"
    f = await _one(client)
    resp = await client.put(f"/api/fireplaces/{f['id']}", json={"control": "auto"})
    assert resp.status == 400


async def test_a_fault_never_reaches_the_engine_tick(client, house, monkeypatch, caplog):
    scheduler = client.app["scheduler"]

    async def boom(*_a, **_k):
        raise RuntimeError("db gone")

    monkeypatch.setattr(scheduler.fireplaces, "evaluate", boom)
    assert await scheduler._evaluate_fireplaces() == set()
    assert "Could not evaluate fireplaces" in caplog.text


async def test_readings_note_a_warm_fireplace(client, fake_ha, house):
    await _add(client, house)  # watching is enough to mark the record
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    await scheduler._sample_rooms()
    await fake_ha.set_entity_state(RELAY, "on")
    by_room = {s.room_id: s.fireplace for s in await learning.load(conn)}
    assert by_room == {house["great"]: False, house["loft"]: False, house["kitchen"]: None}
    await conn.execute("DELETE FROM room_readings")
    await scheduler._sample_rooms()
    by_room = {s.room_id: s.fireplace for s in await learning.load(conn)}
    assert by_room == {house["great"]: True, house["loft"]: True, house["kitchen"]: None}
    # A fireplace that is off is not part of the record.
    f = await _one(client)
    await client.put(f"/api/fireplaces/{f['id']}", json={"control": "off"})
    assert scheduler.fireplaces.warmed_rooms() == {}


async def test_removing_a_lit_fireplace_frees_its_rooms(client, fake_ha, house):
    f = await _add(client, house, control="on")
    await fake_ha.set_entity_state(RELAY, "on")
    assert client.app["scheduler"]._pause_for(T1)[1]
    await client.delete(f"/api/fireplaces/{f['id']}")
    assert client.app["scheduler"]._pause_for(T1) == (False, frozenset())
    assert client.app["scheduler"].fireplaces._lit_since == {}


async def test_changes_apply_without_a_logger_or_a_running_engine(client, fake_ha, house):
    scheduler = client.app["scheduler"]
    await _add(client, house, control="on")
    logger, engines = scheduler._event_logger, dict(scheduler._engines)
    scheduler._event_logger = None
    scheduler._engines.clear()
    try:
        await fake_ha.set_entity_state(RELAY, "on")
        await scheduler.refresh_fireplaces()
    finally:
        scheduler._event_logger = logger
        scheduler._engines.update(engines)
    assert scheduler._pause_for(T1)[1] == frozenset({house["great"], house["loft"]})
