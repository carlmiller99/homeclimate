"""Buildings and zone profiles (HomeClimate phase 4)."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio

T1 = "climate.upstairs"
T2 = "climate.wing"


async def _thermostat(client, entity_id: str, name: str) -> None:
    resp = await client.post(
        "/api/thermostats",
        json={"thermostat_entity_id": entity_id, "name": name, "total_vents_count": 4},
    )
    assert resp.status in (200, 201), await resp.text()


async def test_building_crud(client):
    assert await (await client.get("/api/buildings")).json() == []

    resp = await client.post("/api/buildings", json={"name": "  Main   House "})
    assert resp.status == 201
    main = await resp.json()
    assert main["name"] == "Main House"
    assert main["sort_order"] == 0

    den = await (await client.post("/api/buildings", json={"name": "The Den"})).json()
    assert den["sort_order"] == 1

    dup = await client.post("/api/buildings", json={"name": "main house"})
    assert dup.status == 400
    assert "already exists" in (await dup.json())["error"]

    resp = await client.put(f"/api/buildings/{den['id']}", json={"name": "Den", "sort_order": 0})
    assert (await resp.json()) == {"id": den["id"], "name": "Den", "sort_order": 0}
    names = [b["name"] for b in await (await client.get("/api/buildings")).json()]
    assert names == ["Den", "Main House"]

    clash = await client.put(f"/api/buildings/{den['id']}", json={"name": "MAIN HOUSE"})
    assert clash.status == 400
    # Renaming to its own name (any case) is fine.
    same = await client.put(f"/api/buildings/{den['id']}", json={"name": "den"})
    assert same.status == 200

    assert (await client.put("/api/buildings/nope", json={"name": "X"})).status == 404
    assert (await client.delete("/api/buildings/nope")).status == 404
    assert (await client.delete(f"/api/buildings/{den['id']}")).status == 200
    assert [b["name"] for b in await (await client.get("/api/buildings")).json()] == ["Main House"]


@pytest.mark.parametrize(
    "body",
    [{}, {"name": ""}, {"name": "   "}, {"name": 5}, {"name": "x" * 61}],
)
async def test_building_name_validation(client, body):
    resp = await client.post("/api/buildings", json=body)
    assert resp.status == 400


@pytest.mark.parametrize("sort_order", [-1, 1000, "2", 1.5, True])
async def test_building_sort_order_validation(client, sort_order):
    b = await (await client.post("/api/buildings", json={"name": "A"})).json()
    resp = await client.put(f"/api/buildings/{b['id']}", json={"sort_order": sort_order})
    assert resp.status == 400


async def test_non_object_and_non_json_bodies_are_rejected(client):
    resp = await client.post("/api/buildings", json=["Main"])
    assert resp.status == 400
    assert (await resp.json())["error"] == "request body must be a JSON object"
    resp = await client.post(
        "/api/buildings", data="not json", headers={"Content-Type": "application/json"}
    )
    assert resp.status == 400
    assert (await resp.json())["error"] == "request body must be JSON"


async def test_zones_default_and_update(client):
    await _thermostat(client, T2, "South Wing")
    await _thermostat(client, T1, "Upstairs")
    zones = await (await client.get("/api/zones")).json()
    assert [z["name"] for z in zones] == ["South Wing", "Upstairs"]
    assert zones[0] == {
        "thermostat_entity_id": T2,
        "name": "South Wing",
        "building_id": None,
        "sort_order": 0,
        "system_type": "conventional",
        "compressor_stages": 1,
        "backup_heat": "electric",
        "equipment_running_entity": None,
        "heat_kit_confirmed": False,
        "hp_max_step_f": 1.0,
        "hp_recovery_f_per_hr": 2.0,
        "hp_min_runtime_min": 15,
        "hp_min_open_heat_pct": 50,
        "hp_switchover_gap_min": 60,
        "hp_compressor_lockout_f": None,
        "hp_aux_policy": "avoid",
        "aux_heat_running": False,
        "strips_expected": False,
        "looks_like_heat_pump": False,
    }

    main = await (await client.post("/api/buildings", json={"name": "Main House"})).json()
    resp = await client.put(
        f"/api/zones/{T2}",
        json={
            "building_id": main["id"],
            "sort_order": 2,
            "system_type": "heat_pump",
            "compressor_stages": 2,
            "backup_heat": "none",
            "equipment_running_entity": "climate.wing_cloud",
            "heat_kit_confirmed": True,
        },
    )
    assert resp.status == 200
    zone = await resp.json()
    assert zone["system_type"] == "heat_pump"
    assert zone["building_id"] == main["id"]

    # Partial update keeps the rest; empty entity clears to null.
    zone = await (
        await client.put(f"/api/zones/{T2}", json={"equipment_running_entity": ""})
    ).json()
    assert zone["equipment_running_entity"] is None
    assert zone["compressor_stages"] == 2

    # Ordering follows sort_order.
    zones = await (await client.get("/api/zones")).json()
    assert [z["name"] for z in zones] == ["Upstairs", "South Wing"]

    # Deleting a building keeps its zones and leaves them in no building; the
    # building's own mode and zone-balance settings go with it.
    await client.put(f"/api/building-modes/{main['id']}", json={"mode": "heat_only"})
    await client.put(f"/api/zone-balance/{main['id']}", json={"level": "watch"})
    in_main = [z for z in zones if z["building_id"] == main["id"]]
    assert in_main, "the test needs a zone in the building it deletes"
    assert (await client.delete(f"/api/buildings/{main['id']}")).status == 200
    after = {z["thermostat_entity_id"]: z for z in await (await client.get("/api/zones")).json()}
    assert all(after[z["thermostat_entity_id"]]["building_id"] is None for z in in_main)
    assert main["id"] not in {b["id"] for b in await (await client.get("/api/buildings")).json()}
    modes = await (await client.get("/api/building-modes")).json()
    assert main["id"] not in str(modes)
    balance = await (await client.get("/api/zone-balance")).json()
    assert main["id"] not in str(balance)
    assert (await client.delete(f"/api/buildings/{main['id']}")).status == 404

    # Deleting the thermostat removes its profile.
    await client.put(f"/api/zones/{T1}", json={"system_type": "heat_pump"})
    assert (await client.delete(f"/api/thermostats/{T1}")).status == 200
    zones = await (await client.get("/api/zones")).json()
    assert [z["thermostat_entity_id"] for z in zones] == [T2]


async def test_deleting_a_building_unassigns_nothing_it_does_not_own(client):
    await _thermostat(client, T1, "Upstairs")
    a = await (await client.post("/api/buildings", json={"name": "A"})).json()
    await client.put(f"/api/zones/{T1}", json={"building_id": a["id"]})
    zone = (await (await client.get("/api/zones")).json())[0]
    assert zone["building_id"] == a["id"]


@pytest.mark.parametrize(
    "body",
    [
        {"building_id": "missing"},
        {"building_id": 3},
        {"sort_order": -1},
        {"system_type": "geothermal"},
        {"compressor_stages": 0},
        {"compressor_stages": 4},
        {"backup_heat": "wood"},
        {"equipment_running_entity": "notanentity"},
        {"equipment_running_entity": 7},
        {"heat_kit_confirmed": "yes"},
        {"hp_max_step_f": 0.2},
        {"hp_max_step_f": "1"},
        {"hp_recovery_f_per_hr": 11},
        {"hp_min_runtime_min": 61},
        {"hp_min_open_heat_pct": 101},
        {"hp_switchover_gap_min": -1},
        {"hp_compressor_lockout_f": 90},
        {"hp_compressor_lockout_f": True},
        {"hp_aux_policy": "sometimes"},
    ],
)
async def test_zone_validation(client, body):
    await _thermostat(client, T1, "Upstairs")
    resp = await client.put(f"/api/zones/{T1}", json=body)
    assert resp.status == 400


async def test_heat_pump_guards_convert_at_the_write_boundary(client):
    await _thermostat(client, T1, "Upstairs")
    body = {
        "hp_max_step_f": 1,
        "hp_recovery_f_per_hr": 2,
        "hp_min_runtime_min": 20,
        "hp_min_open_heat_pct": 60,
        "hp_switchover_gap_min": 90,
        "hp_compressor_lockout_f": 5,
        "hp_aux_policy": "allow",
    }
    scheduler = client.app["scheduler"]
    scheduler._active_unit = "C"
    try:
        zone = await (await client.put(f"/api/zones/{T1}", json=body)).json()
    finally:
        scheduler._active_unit = "F"
    # 1 °C step = 1.8 °F, 2 °C/hr = 3.6 °F/hr, 5 °C = 41 °F; minutes and % untouched.
    assert zone["hp_max_step_f"] == 1.8
    assert zone["hp_recovery_f_per_hr"] == 3.6
    assert zone["hp_compressor_lockout_f"] == 41.0
    assert (zone["hp_min_runtime_min"], zone["hp_min_open_heat_pct"]) == (20, 60)
    assert zone["hp_switchover_gap_min"] == 90
    assert zone["hp_aux_policy"] == "allow"

    zone = await (
        await client.put(
            f"/api/zones/{T1}", json={"hp_compressor_lockout_f": None, "hp_max_step_f": 2.5}
        )
    ).json()
    assert zone["hp_compressor_lockout_f"] is None
    assert zone["hp_max_step_f"] == 2.5


async def test_unknown_zone_is_404(client):
    resp = await client.put("/api/zones/climate.nope", json={"system_type": "heat_pump"})
    assert resp.status == 404


async def test_equipment_hint_and_the_flag_on_a_conventional_zone(client, fake_ha):
    await _thermostat(client, T2, "South Wing")
    await _thermostat(client, T1, "Upstairs")

    # Nothing in Home Assistant says either way: no suggestion, no flag.
    hint = await (
        await client.get("/api/ha/equipment-hint", params={"thermostat_entity_id": T2})
    ).json()
    assert hint == {"system_type": None, "auxiliary_heat": False, "reason": None}
    zones = {z["thermostat_entity_id"]: z for z in await (await client.get("/api/zones")).json()}
    assert zones[T2]["looks_like_heat_pump"] is False

    # The ecobee integration's switch for a thermostat with auxiliary heat.
    fake_ha.seed_state("switch.wing_aux_heat_only", "off", {})
    hint = await (
        await client.get("/api/ha/equipment-hint", params={"thermostat_entity_id": T2})
    ).json()
    assert hint == {"system_type": "heat_pump", "auxiliary_heat": True, "reason": "aux_switch"}
    zones = {z["thermostat_entity_id"]: z for z in await (await client.get("/api/zones")).json()}
    assert zones[T2]["looks_like_heat_pump"] is True
    assert zones[T1]["looks_like_heat_pump"] is False

    # Once the zone is set as a heat pump there is nothing left to point out.
    resp = await client.put(f"/api/zones/{T2}", json={"system_type": "heat_pump"})
    assert resp.status == 200
    zones = {z["thermostat_entity_id"]: z for z in await (await client.get("/api/zones")).json()}
    assert zones[T2]["looks_like_heat_pump"] is False


async def test_equipment_hint_needs_a_climate_entity(client):
    for bad in ({}, {"thermostat_entity_id": "sensor.outdoor"}, {"thermostat_entity_id": "  "}):
        resp = await client.get("/api/ha/equipment-hint", params=bad)
        assert resp.status == 400
