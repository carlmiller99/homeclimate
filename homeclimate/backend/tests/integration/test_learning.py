"""Smart Learning: the always-on room sampler, its settings and its status."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import learning
from backend.user_errors import UserError

pytestmark = pytest.mark.asyncio

T1 = "climate.upstairs"
T2 = "climate.wing"
NOW = datetime(2026, 1, 5, 12, 0, tzinfo=UTC)


async def _room(client, name: str, thermostat: str) -> str:
    resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": thermostat})
    assert resp.status == 201, await resp.text()
    return str((await resp.json())["id"])


async def _add(client, room: str, kind: str, entity_id: str) -> None:
    resp = await client.post(f"/api/rooms/{room}/{kind}", json={"entity_id": entity_id})
    assert resp.status in (200, 201), await resp.text()


@pytest.fixture
async def house(client, fake_ha):
    bunk = await _room(client, "Bunk Room", T1)
    craft = await _room(client, "Craft Room", T1)
    den = await _room(client, "Den", T2)
    fake_ha.seed_state(T1, "heat", {"current_temperature": 68, "hvac_action": "heating"})
    fake_ha.seed_state(T2, "cool", {"current_temperature": "n/a"})
    for eid, value in (("sensor.bunk_a", "66"), ("sensor.bunk_b", "68"), ("sensor.craft", "70")):
        fake_ha.seed_state(eid, value, {"unit_of_measurement": "°F"})
    await _add(client, bunk, "sensors", "sensor.bunk_a")
    await _add(client, bunk, "sensors", "sensor.bunk_b")
    await _add(client, craft, "sensors", "sensor.craft")
    fake_ha.seed_state("cover.bunk_vent", "open", {})
    fake_ha.seed_state("cover.craft_vent_1", "closed", {})
    fake_ha.seed_state("cover.craft_vent_2", "closed", {})
    await _add(client, bunk, "vents", "cover.bunk_vent")
    await _add(client, craft, "vents", "cover.craft_vent_1")
    await _add(client, craft, "vents", "cover.craft_vent_2")
    fake_ha.seed_state("binary_sensor.bunk_occ", "on", {})
    fake_ha.seed_state("binary_sensor.craft_occ", "off", {})
    fake_ha.seed_state("binary_sensor.den_occ", "unavailable", {})
    await _add(client, bunk, "presence", "binary_sensor.bunk_occ")
    await _add(client, craft, "presence", "binary_sensor.craft_occ")
    await _add(client, den, "presence", "binary_sensor.den_occ")
    fake_ha.seed_state("sensor.outside", "41", {"unit_of_measurement": "°F"})
    return {"bunk": bunk, "craft": craft, "den": den}


async def _rows(client) -> dict[str, dict]:
    conn = await client.app["scheduler"].get_db()
    async with conn.execute("SELECT * FROM room_samples ORDER BY id") as cur:
        return {r["room_id"]: dict(r) for r in await cur.fetchall()}


async def test_one_sample_per_room_with_everything_around_it(client, fake_ha, house):
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    resp = await client.put(
        "/api/settings/outside-temp-entity", json={"entity_id": "sensor.outside"}
    )
    assert resp.status == 200, await resp.text()
    # A window open in the Craft Room.
    fake_ha.seed_state("binary_sensor.craft_window", "on", {})
    resp = await client.put(
        "/api/smart-control/contacts/binary_sensor.craft_window",
        json={"room_id": house["craft"], "pauses": "room"},
    )
    assert resp.status == 200, await resp.text()

    await scheduler._sample_rooms()
    rows = await _rows(client)
    assert set(rows) == set(house.values())

    bunk = rows[house["bunk"]]
    assert bunk["room_temp"] == 67.0  # mean of its two sensors
    assert (bunk["zone_temp"], bunk["outside_temp"]) == (68.0, 41.0)
    assert (bunk["hvac_action"], bunk["aux_heat"]) == ("heating", 0)
    # Its one vent is open; the zone has one of three open.
    assert (bunk["vent_open"], bunk["zone_vent_open"]) == (1.0, 0.333)
    assert (bunk["occupied"], bunk["opening"]) == (1, 0)
    assert bunk["thermostat_entity_id"] == T1

    craft = rows[house["craft"]]
    assert (craft["room_temp"], craft["vent_open"], craft["zone_vent_open"]) == (70.0, 0.0, 0.333)
    assert (craft["occupied"], craft["opening"]) == (0, 1)

    # No sensors, no vents, a presence sensor that is offline, a thermostat
    # with no usable reading: every unknown is stored as NULL, not guessed.
    den = rows[house["den"]]
    assert den["room_temp"] is None and den["zone_temp"] is None
    assert den["vent_open"] is None and den["zone_vent_open"] is None
    assert den["occupied"] is None
    assert den["hvac_action"] == "unknown"
    assert conn is not None


async def test_stale_sensors_are_left_out_and_celsius_thermostats_convert(client, fake_ha, house):
    scheduler = client.app["scheduler"]
    old = (datetime.now(UTC) - timedelta(hours=5)).isoformat()
    fake_ha.seed_state("sensor.bunk_a", "40", {"unit_of_measurement": "°F"}, last_updated=old)
    fake_ha.ha_temp_unit = "C"
    fake_ha.seed_state(T1, "heat", {"current_temperature": 20, "hvac_action": "idle"})
    try:
        await scheduler._sample_rooms()
    finally:
        fake_ha.ha_temp_unit = "F"
    bunk = (await _rows(client))[house["bunk"]]
    assert bunk["room_temp"] == 68.0  # only the fresh sensor
    assert bunk["zone_temp"] == 68.0  # 20 °C
    assert bunk["outside_temp"] is None  # no outside sensor configured


async def test_a_bad_staleness_setting_falls_back_to_the_default(client, fake_ha, house):
    from backend import db

    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    await db.set_system_setting(conn, "sensor_stale_after_min", "soon")
    await scheduler._sample_rooms()
    assert (await _rows(client))[house["bunk"]]["room_temp"] == 67.0


async def test_sampling_can_be_turned_off_and_old_samples_age_out(client, fake_ha, house):
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    await scheduler._sample_rooms()
    assert len(await _rows(client)) == 3

    # Make those samples 40 days old; they survive a 60-day window…
    await conn.execute(
        "UPDATE room_samples SET ts = ?", ((datetime.now(UTC) - timedelta(days=40)).isoformat(),)
    )
    await conn.commit()
    resp = await client.put("/api/learning/settings", json={"sampling_enabled": False})
    assert resp.status == 200
    await scheduler._sample_rooms()
    async with conn.execute("SELECT COUNT(*) AS n FROM room_samples") as cur:
        assert (await cur.fetchone())["n"] == 3  # nothing new, nothing purged

    # …and go once the window is shorter than their age, even with sampling off.
    resp = await client.put("/api/learning/settings", json={"sample_retention_days": 30})
    assert (await resp.json())["settings"] == {
        "sampling_enabled": False,
        "sample_retention_days": 30,
    }
    await scheduler._sample_rooms()
    async with conn.execute("SELECT COUNT(*) AS n FROM room_samples") as cur:
        assert (await cur.fetchone())["n"] == 0


async def test_a_sampling_failure_never_escapes(client, house, monkeypatch, caplog):
    async def boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(learning, "store", boom)
    await client.app["scheduler"]._sample_rooms()
    assert "Could not sample rooms for Smart Learning" in caplog.text


async def test_nothing_is_sampled_before_the_vent_controller_exists(client, house):
    scheduler = client.app["scheduler"]
    saved, scheduler._vent_ctrl = scheduler._vent_ctrl, None
    try:
        await scheduler._sample_rooms()
    finally:
        scheduler._vent_ctrl = saved
    assert await _rows(client) == {}


async def test_the_sampler_is_scheduled_every_five_minutes(client):
    job = client.app["scheduler"]._apscheduler.get_job("room_sampler")
    assert job is not None
    assert job.trigger.interval == timedelta(minutes=5)


async def test_status_reports_progress_per_room(client, fake_ha, house):
    empty = await (await client.get("/api/learning")).json()
    assert empty["settings"] == {"sampling_enabled": True, "sample_retention_days": 60}
    assert (empty["samples"], empty["collecting_since"], empty["sample_every_min"]) == (0, None, 5)
    assert [r["name"] for r in empty["rooms"]] == ["Bunk Room", "Craft Room", "Den"]
    assert empty["rooms"][0] == {
        "room_id": house["bunk"],
        "name": "Bunk Room",
        "thermostat_entity_id": T1,
        "samples": 0,
        "days": 0.0,
        "with_temperature_pct": 0,
        "first_sample_at": None,
        "last_sample_at": None,
    }

    conn = await client.app["scheduler"].get_db()
    samples = [
        learning.RoomSample(
            ts=NOW + timedelta(minutes=5 * i),
            room_id=house["bunk"],
            thermostat_entity_id=T1,
            room_temp=68.0 if i % 2 else None,
            zone_temp=68.0,
            outside_temp=40.0,
            hvac_action="idle",
            aux_heat=False,
            vent_open=1.0,
            zone_vent_open=0.5,
            occupied=None,
            opening=False,
        )
        for i in range(288)
    ]
    await learning.store(conn, samples)
    snap = await (await client.get("/api/learning")).json()
    assert snap["samples"] == 288
    assert snap["collecting_since"] == NOW.isoformat()
    bunk = snap["rooms"][0]
    assert (bunk["samples"], bunk["days"], bunk["with_temperature_pct"]) == (288, 1.0, 50)
    assert bunk["first_sample_at"] == NOW.isoformat()
    assert bunk["last_sample_at"] == (NOW + timedelta(minutes=5 * 287)).isoformat()
    assert snap["rooms"][1]["samples"] == 0


async def test_settings_are_validated_with_fixed_messages(client):
    for body, message in (
        ({"sampling_enabled": "yes"}, "sampling_enabled must be true or false"),
        (
            {"sample_retention_days": 29},
            "sample_retention_days must be a whole number from 30 to 365",
        ),
        (
            {"sample_retention_days": 366},
            "sample_retention_days must be a whole number from 30 to 365",
        ),
        (
            {"sample_retention_days": True},
            "sample_retention_days must be a whole number from 30 to 365",
        ),
        (
            {"sample_retention_days": 45.5},
            "sample_retention_days must be a whole number from 30 to 365",
        ),
        ({"nope": 1}, "Unknown learning setting"),
    ):
        resp = await client.put("/api/learning/settings", json=body)
        assert resp.status == 400, body
        assert (await resp.json())["error"] == message
    # A rejected body changes nothing, even its valid keys.
    resp = await client.put(
        "/api/learning/settings", json={"sample_retention_days": 90, "sampling_enabled": 3}
    )
    assert resp.status == 400
    settings = (await (await client.get("/api/learning")).json())["settings"]
    assert settings == {"sampling_enabled": True, "sample_retention_days": 60}
    assert (await client.put("/api/learning/settings", json=[1])).status == 400


async def test_stored_settings_that_are_no_longer_valid_read_as_defaults(client):
    from backend import db

    conn = await client.app["scheduler"].get_db()
    await db.set_system_setting(conn, "learning_sample_retention_days", "lots")
    assert (await learning.get_settings(conn))["sample_retention_days"] == 60
    await db.set_system_setting(conn, "learning_sample_retention_days", "5")
    assert (await learning.get_settings(conn))["sample_retention_days"] == 60
    await db.set_system_setting(conn, "learning_sample_retention_days", "120")
    assert (await learning.get_settings(conn))["sample_retention_days"] == 120
    with pytest.raises(UserError):
        learning.parse_setting("sampling_enabled", 1)
