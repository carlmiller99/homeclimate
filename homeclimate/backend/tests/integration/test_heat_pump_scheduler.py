"""Heat pump guards and backup-heat logging through the scheduler."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio

T1 = "climate.upstairs"
CLOUD = "climate.upstairs_cloud"


async def test_guards_follow_zone_edits_and_backup_heat_is_logged(client, fake_ha, tick):
    resp = await client.post(
        "/api/thermostats",
        json={"thermostat_entity_id": T1, "name": "Upstairs", "total_vents_count": 4},
    )
    assert resp.status in (200, 201)
    # Engines exist for thermostats that serve a room.
    await client.post("/api/rooms", json={"name": "Bunk Room", "thermostat_entity_id": T1})
    scheduler = client.app["scheduler"]
    await tick()
    assert scheduler._heat_pumps == {}

    fake_ha.seed_state(CLOUD, "heat", {"equipment_running": "heatPump,fan"})
    await client.put(
        f"/api/zones/{T1}", json={"system_type": "heat_pump", "equipment_running_entity": CLOUD}
    )
    assert T1 in scheduler._heat_pumps
    engine = scheduler.get_engine(T1)
    assert engine is not None and engine._heat_pump() is scheduler._heat_pumps[T1]

    await tick()
    zones = await (await client.get("/api/zones")).json()
    assert zones[0]["aux_heat_running"] is False

    fake_ha.seed_state(CLOUD, "heat", {"equipment_running": "heatPump,auxHeat1,fan"})
    await tick()
    zones = await (await client.get("/api/zones")).json()
    assert zones[0]["aux_heat_running"] is True
    fake_ha.seed_state(CLOUD, "heat", {"equipment_running": "heatPump,fan"})
    await tick()

    events = await (await client.get("/api/logs/events?category=engine")).json()
    messages = [e["message"] for e in (events["events"] if isinstance(events, dict) else events)]
    assert "Backup heat started on Upstairs" in messages
    assert any(m.startswith("Backup heat stopped on Upstairs after ") for m in messages)

    # Without a logger, episodes are still tracked.
    scheduler._event_logger = None
    fake_ha.seed_state(CLOUD, "heat", {"equipment_running": "auxHeat1"})
    await scheduler._watch_backup_heat()
    assert scheduler.aux_heat_running(T1)

    await client.put(f"/api/zones/{T1}", json={"system_type": "conventional"})
    assert scheduler._heat_pumps == {}
