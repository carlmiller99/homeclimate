"""Smart Learning: the always-on room sampler, its settings and its status."""

from __future__ import annotations

from dataclasses import asdict
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
    return {s.room_id: asdict(s) for s in await learning.load(conn)}


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
    assert (bunk["hvac_action"], bunk["aux_heat"]) == ("heating", False)
    # Its one vent is open; the zone has one of three open.
    assert (bunk["vent_open"], bunk["zone_vent_open"]) == (1.0, 0.333)
    assert (bunk["occupied"], bunk["opening"]) == (True, None)  # no door or window sensor
    assert bunk["thermostat_entity_id"] == T1

    craft = rows[house["craft"]]
    assert (craft["room_temp"], craft["vent_open"], craft["zone_vent_open"]) == (70.0, 0.0, 0.333)
    assert (craft["occupied"], craft["opening"]) == (False, True)

    # No sensors, no vents, a presence sensor that is offline, a thermostat
    # with no usable reading: every unknown is stored as NULL, not guessed.
    den = rows[house["den"]]
    assert den["room_temp"] is None and den["zone_temp"] is None
    assert den["vent_open"] is None and den["zone_vent_open"] is None
    assert den["occupied"] is None and den["opening"] is None
    # Readings sit on the 5-minute grid.
    assert den["ts"].minute % 5 == 0 and den["ts"].second == 0
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
        "UPDATE room_readings SET ts = ?",
        (int((datetime.now(UTC) - timedelta(days=40)).timestamp()),),
    )
    await conn.commit()
    resp = await client.put("/api/learning/settings", json={"sampling_enabled": False})
    assert resp.status == 200
    await scheduler._sample_rooms()
    async with conn.execute("SELECT COUNT(*) AS n FROM room_readings") as cur:
        assert (await cur.fetchone())["n"] == 3  # nothing new, nothing purged

    # …and go once the window is shorter than their age, even with sampling off.
    resp = await client.put("/api/learning/settings", json={"sample_retention_days": 30})
    assert (await resp.json())["settings"] == {
        "sampling_enabled": False,
        "sample_retention_days": 30,
        "early_start_level": 0,
        "coast_level": 0,
        "arrival_level": 0,
        "early_cool_level": 0,
        "stop_early_level": 0,
    }
    await scheduler._sample_rooms()
    async with conn.execute("SELECT COUNT(*) AS n FROM room_readings") as cur:
        assert (await cur.fetchone())["n"] == 0


async def test_a_sampling_failure_never_escapes(client, house, monkeypatch, caplog):
    async def boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(learning, "store", boom)
    monkeypatch.setattr(learning, "purge", boom)
    await client.app["scheduler"]._sample_rooms()
    assert "Could not sample rooms for Smart Learning" in caplog.text
    assert "Could not clear old Smart Learning readings" in caplog.text


async def test_a_failed_store_still_clears_old_readings(client, house, monkeypatch):
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    await scheduler._sample_rooms()
    await conn.execute("UPDATE room_readings SET ts = 0")
    await conn.commit()

    async def boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(learning, "store", boom)
    await scheduler._sample_rooms()
    assert await _rows(client) == {}


async def test_nothing_is_recorded_while_home_assistant_is_disconnected(client, fake_ha, house):
    fake_ha._connected.clear()
    try:
        await client.app["scheduler"]._sample_rooms()
    finally:
        fake_ha._connected.set()
    assert await _rows(client) == {}


async def test_the_thermostats_own_probe_counts_for_rooms_that_use_it(client, fake_ha, house):
    resp = await client.put(f"/api/rooms/{house['den']}", json={"include_thermostat_sensor": True})
    assert resp.status == 200, await resp.text()
    resp = await client.put(
        f"/api/rooms/{house['craft']}", json={"include_thermostat_sensor": True}
    )
    assert resp.status == 200, await resp.text()
    fake_ha.seed_state(T2, "cool", {"current_temperature": 74.5})
    await client.app["scheduler"]._sample_rooms()
    rows = await _rows(client)
    assert rows[house["den"]]["room_temp"] == 74.5  # its only source
    assert rows[house["craft"]]["room_temp"] == 69.0  # sensor 70 and probe 68


async def test_broken_values_are_left_out_not_fatal(client, fake_ha, house):
    fake_ha.seed_state("sensor.bunk_a", "nan", {"unit_of_measurement": "°F"})
    fake_ha.seed_state("sensor.craft", "inf", {"unit_of_measurement": "°F"})
    fake_ha.seed_state(T1, "heat", {"current_temperature": float("nan")})
    await client.app["scheduler"]._sample_rooms()
    rows = await _rows(client)
    assert rows[house["bunk"]]["room_temp"] == 68.0
    assert rows[house["craft"]]["room_temp"] is None
    assert rows[house["bunk"]]["zone_temp"] is None


async def test_vents_record_position_and_offline_vents_are_unknown(client, fake_ha, house):
    resp = await client.patch(
        f"/api/rooms/{house['craft']}/vents/cover.craft_vent_1",
        json={"control_method": "set_position"},
    )
    assert resp.status == 200, await resp.text()
    fake_ha.seed_state("cover.craft_vent_1", "open", {"current_position": 30})
    fake_ha.seed_state("cover.craft_vent_2", "unavailable", {})
    await client.app["scheduler"]._sample_rooms()
    rows = await _rows(client)
    assert rows[house["craft"]]["vent_open"] == 0.3  # the offline vent is left out
    assert rows[house["bunk"]]["zone_vent_open"] == 0.65  # (1.0 + 0.3) / 2

    # A position that isn't a usable number falls back to open/closed.
    fake_ha.seed_state("cover.craft_vent_1", "closed", {"current_position": "?"})
    del fake_ha._state["cover.bunk_vent"]
    await client.app["scheduler"]._sample_rooms()
    rows = await _rows(client)
    assert rows[house["craft"]]["vent_open"] == 0.0
    assert rows[house["bunk"]]["vent_open"] is None


async def test_doors_are_open_closed_or_unknown(client, fake_ha, house):
    for eid, room, state in (
        ("binary_sensor.bunk_door", "bunk", "off"),
        ("binary_sensor.bunk_window", "bunk", "off"),
        ("binary_sensor.craft_door", "craft", "off"),
        ("binary_sensor.craft_window", "craft", "unavailable"),
    ):
        fake_ha.seed_state(eid, state, {})
        resp = await client.put(
            f"/api/smart-control/contacts/{eid}", json={"room_id": house[room], "pauses": "room"}
        )
        assert resp.status == 200, await resp.text()
    # A sensor still attached to a whole zone belongs to no room's record.
    conn = await client.app["scheduler"].get_db()
    await conn.execute(
        "INSERT INTO contact_sensors(entity_id, thermostat_entity_id, room_id, pauses)"
        " VALUES('binary_sensor.hall', ?, NULL, 'zone')",
        (T2,),
    )
    await conn.commit()
    fake_ha.seed_state("binary_sensor.hall", "on", {})
    await client.app["scheduler"]._sample_rooms()
    rows = await _rows(client)
    assert rows[house["bunk"]]["opening"] is False  # every sensor says closed
    assert rows[house["craft"]]["opening"] is None  # one can't say
    assert rows[house["den"]]["opening"] is None  # nothing to say it


async def test_readings_from_the_first_build_are_moved_over(client, house, caplog):
    conn = await client.app["scheduler"].get_db()
    await client.app["scheduler"].adopt_first_build_readings()  # nothing to move
    await conn.executescript(
        """CREATE TABLE room_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
               room_id TEXT NOT NULL, thermostat_entity_id TEXT NOT NULL, room_temp REAL,
               zone_temp REAL, outside_temp REAL, hvac_action TEXT NOT NULL,
               aux_heat INTEGER NOT NULL DEFAULT 0, vent_open REAL, zone_vent_open REAL,
               occupied INTEGER, opening INTEGER NOT NULL DEFAULT 0);
           CREATE INDEX idx_room_samples_room_ts ON room_samples(room_id, ts);
           CREATE INDEX idx_room_samples_ts ON room_samples(ts);"""
    )
    await conn.executemany(
        "INSERT INTO room_samples(ts, room_id, thermostat_entity_id, room_temp, zone_temp,"
        " outside_temp, hvac_action, aux_heat, vent_open, zone_vent_open, occupied, opening)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            (
                "2026-01-05T12:02:42.714000+00:00",
                "r-old",
                T1,
                67.5,
                68.0,
                41.0,
                "heating",
                1,
                1.0,
                0.5,
                1,
                1,
            ),
            (
                "2026-01-05T12:07:42.714000+00:00",
                "r-old",
                T1,
                None,
                68.0,
                None,
                "idle",
                0,
                0.0,
                0.0,
                None,
                0,
            ),
        ],
    )
    await conn.commit()
    with caplog.at_level("INFO"):
        await client.app["scheduler"].adopt_first_build_readings()
    assert "Moved 2 Smart Learning readings into compact storage" in caplog.text
    first, second = await learning.load(conn, room_id="r-old")
    assert first == learning.RoomSample(
        datetime(2026, 1, 5, 12, 0, tzinfo=UTC),
        "r-old",
        T1,
        67.5,
        68.0,
        41.0,
        "heating",
        True,
        1.0,
        0.5,
        True,
        True,
    )
    # "Closed" and "no opening" from that build could have meant offline: unknown now.
    assert second == learning.RoomSample(
        datetime(2026, 1, 5, 12, 5, tzinfo=UTC),
        "r-old",
        T1,
        None,
        68.0,
        None,
        "idle",
        False,
        None,
        None,
        None,
        None,
    )
    async with conn.execute("SELECT name FROM sqlite_master WHERE name LIKE '%room_samples%'") as c:
        assert await c.fetchall() == []


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
    assert "minute='*/5'" in str(job.trigger)


async def test_status_reports_progress_per_room(client, fake_ha, house):
    empty = await (await client.get("/api/learning")).json()
    assert empty["settings"] == {
        "sampling_enabled": True,
        "sample_retention_days": 60,
        "early_start_level": 0,
        "coast_level": 0,
        "arrival_level": 0,
        "early_cool_level": 0,
        "stop_early_level": 0,
    }
    assert (empty["samples"], empty["collecting_since"], empty["sample_every_min"]) == (0, None, 5)
    assert empty["last_sample_at"] is None
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
        "model": None,
        "stop_early": None,
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
    assert snap["last_sample_at"] == (NOW + timedelta(minutes=5 * 287)).isoformat()
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
    assert settings == {
        "sampling_enabled": True,
        "sample_retention_days": 60,
        "early_start_level": 0,
        "coast_level": 0,
        "arrival_level": 0,
        "early_cool_level": 0,
        "stop_early_level": 0,
    }
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


async def test_readings_are_stored_compactly_and_read_back_unchanged(client, house):
    conn = await client.app["scheduler"].get_db()
    one = learning.RoomSample(
        ts=NOW,
        room_id=house["bunk"],
        thermostat_entity_id=T1,
        room_temp=67.89,
        zone_temp=-4.5,
        outside_temp=104.01,
        hvac_action="defrosting",
        aux_heat=True,
        vent_open=0.333,
        zone_vent_open=1.0,
        occupied=False,
        opening=True,
    )
    blank = learning.RoomSample(
        NOW, house["den"], T2, None, None, None, "idle", False, None, None, None, False
    )
    later = learning.RoomSample(
        **{**asdict(one), "ts": NOW + timedelta(minutes=5), "room_temp": 68.0}
    )
    await learning.store(conn, [one, blank, later])
    # Storing the same moment again replaces it rather than doubling it.
    await learning.store(conn, [one])
    assert await learning.load(conn) == [one, later, blank]
    assert await learning.load(conn, room_id=house["den"]) == [blank]
    assert await learning.load(conn, since=NOW + timedelta(minutes=1)) == [later]

    # Every stored value is a small integer or NULL, and each text value is numbered once.
    async with conn.execute("SELECT * FROM room_readings ORDER BY room_key, ts") as cur:
        raw = [tuple(r) for r in await cur.fetchall()]
    assert all(v is None or isinstance(v, int) for row in raw for v in row)
    assert raw[0][4:7] == (6789, -450, 10401)
    async with conn.execute("SELECT kind, value FROM room_reading_keys ORDER BY key") as cur:
        keys = [tuple(r) for r in await cur.fetchall()]
    assert sorted(keys) == sorted(
        [
            ("room", house["bunk"]),
            ("zone", T1),
            ("action", "defrosting"),
            ("room", house["den"]),
            ("zone", T2),
            ("action", "idle"),
        ]
    )


async def test_purge_keeps_a_reading_exactly_at_the_cutoff(client, house):
    conn = await client.app["scheduler"].get_db()

    def mk(ts: datetime) -> learning.RoomSample:
        return learning.RoomSample(
            ts, house["bunk"], T1, 68.0, 68.0, None, "idle", False, None, None, None, None
        )

    await learning.store(
        conn, [mk(NOW - timedelta(days=30)), mk(NOW - timedelta(days=30, minutes=5))]
    )
    assert await learning.purge(conn, now=NOW, keep_days=30) == 1
    assert [s.ts for s in await learning.load(conn)] == [NOW - timedelta(days=30)]


async def test_a_bad_reading_in_the_first_builds_table_cannot_stop_start_up(
    client, monkeypatch, caplog
):
    conn = await client.app["scheduler"].get_db()
    await conn.executescript(
        """CREATE TABLE room_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
               room_id TEXT NOT NULL, thermostat_entity_id TEXT NOT NULL, room_temp REAL,
               zone_temp REAL, outside_temp REAL, hvac_action TEXT NOT NULL,
               aux_heat INTEGER NOT NULL DEFAULT 0, vent_open REAL, zone_vent_open REAL,
               occupied INTEGER, opening INTEGER NOT NULL DEFAULT 0);"""
    )
    await conn.execute(
        "INSERT INTO room_samples(ts, room_id, thermostat_entity_id, room_temp, hvac_action)"
        " VALUES('2026-01-05T12:02:00+00:00', 'r-old', ?, ?, 'idle')",
        (T1, float("inf")),
    )
    await conn.commit()
    await client.app["scheduler"].adopt_first_build_readings()
    (moved,) = await learning.load(conn, room_id="r-old")
    assert moved.room_temp is None  # the impossible value is dropped, the reading kept

    async def boom(_conn):
        raise RuntimeError("table is corrupt")

    monkeypatch.setattr(learning, "adopt_first_build", boom)
    await client.app["scheduler"].adopt_first_build_readings()
    assert "Could not move Smart Learning readings into compact storage" in caplog.text
