"""Set Up from Home Assistant: preview and import (HomeClimate phase 5)."""

from __future__ import annotations

import pytest

from backend import ha_import

pytestmark = pytest.mark.asyncio


def _seed(fake_ha) -> None:
    fake_ha.seed_state("climate.landing", "heat", {"friendly_name": "Landing Thermostat"})
    fake_ha.seed_state("climate.mud", "heat", {"friendly_name": "Mud Thermostat"})
    fake_ha.seed_state("climate.cloud_copy", "heat", {"friendly_name": "Hidden Copy"})
    for eid, cls, unit in [
        ("sensor.bunk_temp", "temperature", "°F"),
        ("sensor.bunk_temp_c", "temperature", "°C"),
        ("sensor.bunk_humidity", "humidity", "%"),
        ("sensor.bunk_esp_temp", "temperature", "°F"),
        ("sensor.mud_temp", "temperature", "°F"),
    ]:
        fake_ha.seed_state(eid, "70", {"device_class": cls, "unit_of_measurement": unit})
    fake_ha.seed_state("binary_sensor.bunk_occupancy", "off", {"device_class": "occupancy"})
    fake_ha.seed_state(
        "binary_sensor.mud_door", "off", {"device_class": "door", "friendly_name": "Mudroom Door"}
    )
    fake_ha.seed_state("binary_sensor.mud_smoke", "off", {"device_class": "smoke"})
    fake_ha.seed_state("cover.bunk_shade", "open", {"device_class": "shade"})
    fake_ha.seed_state("cover.bunk_vent", "open", {})
    fake_ha.seed_state("cover.gate", "closed", {"device_class": "gate"})
    fake_ha.seed_state(
        "sensor.no_area_temp", "70", {"device_class": "temperature", "unit_of_measurement": "°F"}
    )
    fake_ha.seed_state(
        "sensor.ghost_area_temp", "70", {"device_class": "temperature", "unit_of_measurement": "°F"}
    )
    fake_ha.registries = {
        "areas": [
            {"area_id": "bunk", "name": "Bunk Room", "floor_id": "up"},
            {"area_id": "landing", "name": "Landing", "floor_id": "up"},
            {"area_id": "mud", "name": "Mudroom", "floor_id": None},
            {"area_id": "drive", "name": "Driveway"},
            {"name": "No Id"},
        ],
        "floors": [{"floor_id": "up", "name": "Upstairs"}],
        "devices": [{"id": "dev-bunk", "area_id": "bunk"}],
        "entities": [
            {"entity_id": "climate.landing", "area_id": "landing"},
            {"entity_id": "climate.mud", "area_id": "mud"},
            {"entity_id": "climate.cloud_copy", "area_id": "mud", "hidden_by": "user"},
            {"entity_id": "sensor.bunk_temp", "device_id": "dev-bunk"},
            {"entity_id": "sensor.bunk_temp_c", "area_id": "bunk"},
            {"entity_id": "sensor.bunk_humidity", "area_id": "bunk"},
            {
                "entity_id": "sensor.bunk_esp_temp",
                "area_id": "bunk",
                "entity_category": "diagnostic",
            },
            {"entity_id": "sensor.mud_temp", "area_id": "mud"},
            {"entity_id": "binary_sensor.bunk_occupancy", "area_id": "bunk"},
            {"entity_id": "binary_sensor.mud_door", "area_id": "mud"},
            {"entity_id": "binary_sensor.mud_smoke", "area_id": "mud"},
            {"entity_id": "cover.bunk_shade", "area_id": "bunk"},
            {"entity_id": "cover.bunk_vent", "area_id": "bunk"},
            {"entity_id": "cover.gate", "area_id": "drive"},
            {"entity_id": "sensor.ghost_area_temp", "area_id": "nowhere"},
            {"device_id": "orphan"},
        ],
    }


async def test_preview_suggests_zones_and_rooms(client, fake_ha):
    _seed(fake_ha)
    preview = await (await client.get("/api/ha/import-preview")).json()

    zones = {z["entity_id"]: z for z in preview["zones"]}
    assert set(zones) == {"climate.landing", "climate.mud"}
    assert zones["climate.landing"]["suggested_name"] == "Upstairs"  # floor wins
    assert zones["climate.landing"]["floor_name"] == "Upstairs"
    assert zones["climate.mud"]["suggested_name"] == "Mudroom"  # then area
    assert zones["climate.mud"]["configured"] is False

    rooms = {r["area_id"]: r for r in preview["rooms"]}
    assert set(rooms) == {"bunk", "landing", "mud", "drive"}
    bunk = rooms["bunk"]
    assert bunk["found"] == {
        "temperature": ["sensor.bunk_temp", "sensor.bunk_temp_c"],
        "presence": ["binary_sensor.bunk_occupancy"],
        "contacts": [],
        "shades": ["cover.bunk_shade"],
        "vents": ["cover.bunk_vent"],
    }
    assert bunk["skipped"] is False
    assert bunk["suggested_zone"] is None
    assert rooms["mud"]["found"]["contacts"] == ["binary_sensor.mud_door"]
    assert preview["labels"]["binary_sensor.mud_door"] == "Mudroom Door"
    assert rooms["mud"]["suggested_zone"] == "climate.mud"
    assert rooms["drive"]["skipped"] is True  # nothing useful there
    assert "Bunk Room" in preview["room_names"]
    assert preview["labels"]["sensor.bunk_temp"] == "sensor.bunk_temp"


async def test_preview_without_floors_or_area_uses_friendly_name(client, fake_ha):
    fake_ha.seed_state("climate.loose", "heat", {"friendly_name": "Loose Thermostat"})
    fake_ha.seed_state("climate.bare", "heat", {})
    fake_ha.registries = {"areas": [], "floors": [], "devices": [], "entities": []}
    preview = await (await client.get("/api/ha/import-preview")).json()
    names = {z["entity_id"]: z["suggested_name"] for z in preview["zones"]}
    assert names == {"climate.bare": "climate.bare", "climate.loose": "Loose Thermostat"}


async def test_preview_reports_unreadable_registries(client, fake_ha):
    async def boom():
        raise RuntimeError("no")

    fake_ha.get_registries = boom
    resp = await client.get("/api/ha/import-preview")
    assert resp.status == 503
    assert (await resp.json())["error"] == "Home Assistant's registries could not be read"


async def test_import_is_additive_and_remembers_skips(client, fake_ha):
    _seed(fake_ha)
    body = {
        "zones": [
            {"entity_id": "climate.landing", "name": "Upstairs", "new_building_name": "Main House"},
            {"entity_id": "climate.mud", "name": "North Wing", "new_building_name": "main house"},
        ],
        "rooms": [
            {
                "name": "Bunk Room",
                "zone": "climate.landing",
                "sensors": ["sensor.bunk_temp", "sensor.bunk_temp"],
                "presence": ["binary_sensor.bunk_occupancy"],
                "vents": ["cover.bunk_vent"],
            },
            {
                "name": "Mudroom",
                "zone": "climate.mud",
                "sensors": ["sensor.mud_temp"],
                "contacts": ["binary_sensor.mud_door"],
            },
        ],
        "skipped_areas": ["drive", "drive"],
    }
    resp = await client.post("/api/ha/import", json=body)
    assert resp.status == 200, await resp.text()
    assert await resp.json() == {
        "zones_added": 2,
        "buildings_added": 1,
        "rooms_added": 2,
        "rooms_updated": 0,
        "entities_added": 5,
    }
    contacts = (await (await client.get("/api/smart-control")).json())["sensors"]
    assert [(c["entity_id"], c["room_id"] is not None) for c in contacts] == [
        ("binary_sensor.mud_door", True)
    ]
    zones = await (await client.get("/api/zones")).json()
    buildings = await (await client.get("/api/buildings")).json()
    assert [b["name"] for b in buildings] == ["Main House"]
    assert {z["building_id"] for z in zones} == {buildings[0]["id"]}

    # Running it again adds nothing new; an extra entity lands on the existing room.
    body["rooms"][0]["sensors"].append("sensor.bunk_temp_c")
    body["zones"][0].pop("new_building_name")
    body["zones"][0]["building_id"] = buildings[0]["id"]
    again = await (await client.post("/api/ha/import", json=body)).json()
    assert again == {
        "zones_added": 0,
        "buildings_added": 0,
        "rooms_added": 0,
        "rooms_updated": 2,
        "entities_added": 1,
    }

    preview = await (await client.get("/api/ha/import-preview")).json()
    rooms = {r["area_id"]: r for r in preview["rooms"]}
    assert rooms["bunk"]["existing_room_id"] is not None
    assert rooms["bunk"]["suggested_zone"] == "climate.landing"
    assert rooms["bunk"]["new_entities"] == []
    assert rooms["mud"]["new_entities"] == []
    assert rooms["drive"]["skipped"] is True
    zones_preview = {z["entity_id"]: z for z in preview["zones"]}
    assert zones_preview["climate.landing"]["configured"] is True
    assert zones_preview["climate.landing"]["suggested_name"] == "Upstairs"


async def test_import_reuses_an_existing_building_by_name(client, fake_ha):
    _seed(fake_ha)
    await client.post("/api/buildings", json={"name": "Main House"})
    resp = await client.post(
        "/api/ha/import",
        json={"zones": [{"entity_id": "climate.mud", "new_building_name": "MAIN HOUSE"}]},
    )
    assert (await resp.json())["buildings_added"] == 0
    zone = (await (await client.get("/api/zones")).json())[0]
    assert zone["name"] == "climate.mud"
    assert zone["building_id"] is not None


@pytest.mark.parametrize(
    "body",
    [
        {"zones": "x"},
        {"zones": ["x"]},
        {"zones": [{"entity_id": "climate.nope"}]},
        {"zones": [{"entity_id": "climate.mud", "building_id": "missing"}]},
        {"zones": [{"entity_id": "climate.mud", "new_building_name": "   "}]},
        {"rooms": ["x"]},
        {"rooms": [{"name": "", "zone": "climate.mud"}]},
        {"rooms": [{"name": "!!!", "zone": "climate.mud"}]},
        {"rooms": [{"name": "Den", "zone": "climate.nope"}]},
        {"rooms": [{"name": "Den", "zone": "climate.mud", "sensors": "sensor.x"}]},
        {"rooms": [{"name": "Den", "zone": "climate.mud", "sensors": ["nope"]}]},
        {"rooms": [{"name": "Den", "zone": "climate.mud", "contacts": ["sensor.door"]}]},
        {"skipped_areas": "drive"},
        {"skipped_areas": [1]},
    ],
)
async def test_import_validation(client, fake_ha, body):
    _seed(fake_ha)
    await client.post(
        "/api/thermostats", json={"thermostat_entity_id": "climate.mud", "total_vents_count": 2}
    )
    resp = await client.post("/api/ha/import", json=body)
    assert resp.status == 400


async def test_skipped_area_setting_tolerates_bad_json(client, fake_ha):
    from backend import db

    conn = await client.app["scheduler"].get_db()
    await db.set_system_setting(conn, ha_import.SKIPPED_AREAS_KEY, "not json")
    assert await ha_import.load_skipped_areas(conn) == set()
    await db.set_system_setting(conn, ha_import.SKIPPED_AREAS_KEY, '{"a": 1}')
    assert await ha_import.load_skipped_areas(conn) == set()
    await db.set_system_setting(conn, ha_import.SKIPPED_AREAS_KEY, '["a", 2]')
    assert await ha_import.load_skipped_areas(conn) == {"a"}


async def test_zone_rows_without_a_building_and_unplaced_entities(client, fake_ha):
    _seed(fake_ha)
    fake_ha.registries["entities"].append({"entity_id": "sensor.no_area_temp"})
    await client.post("/api/buildings", json={"name": "Shop"})
    resp = await client.post(
        "/api/ha/import",
        json={
            "zones": [
                {"entity_id": "climate.mud", "name": "North Wing"},
                {"entity_id": "climate.landing", "new_building_name": "Main House"},
            ]
        },
    )
    assert await resp.json() == {
        "zones_added": 2,
        "buildings_added": 1,
        "rooms_added": 0,
        "rooms_updated": 0,
        "entities_added": 0,
    }
    zones = {z["thermostat_entity_id"]: z for z in await (await client.get("/api/zones")).json()}
    assert zones["climate.mud"]["building_id"] is None
    preview = await (await client.get("/api/ha/import-preview")).json()
    found = [e for r in preview["rooms"] for v in r["found"].values() for e in v]
    assert "sensor.no_area_temp" not in found
