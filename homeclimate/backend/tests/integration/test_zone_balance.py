"""Zone Balance: keeping a building's zones within a gap of each other."""

from __future__ import annotations

from datetime import timedelta

import pytest

from backend import db
from backend import zone_balance as zb

T1, T2, T3 = "climate.north", "climate.south", "climate.den"


def _z(tid, temp, occupied=False):
    return zb.ZoneState(tid, temp, occupied)


async def test_a_zone_too_far_behind_an_occupied_one_is_called_to_the_limit():
    zones = [_z(T1, 70.0, True), _z(T2, 64.0), _z(T3, 68.0)]
    assert zb.decide(zones, "heating", 3.0) == {T2: zb.Call("heating", 67.0, T1, 6.0)}
    # Cooling: the warm one is brought down toward the coolest occupied zone.
    zones = [_z(T1, 72.0, True), _z(T2, 78.2), _z(T3, 74.0, True)]
    assert zb.decide(zones, "cooling", 3.0) == {T2: zb.Call("cooling", 75.0, T1, 6.2)}
    # Two occupied zones can each be the other's measure.
    zones = [_z(T1, 70.0, True), _z(T2, 64.0, True)]
    assert zb.decide(zones, "heating", 3.0) == {T2: zb.Call("heating", 67.0, T1, 6.0)}
    assert zb.spread(zones) == 6.0


async def test_what_is_never_balanced():
    apart = [_z(T1, 70.0, True), _z(T2, 64.0)]
    # No direction, the building off, or holding between sides.
    for direction in (None, "off", "hold"):
        assert zb.decide(apart, direction, 3.0) == {}
    # Nobody is using the other zone: an empty building is left alone.
    assert zb.decide([_z(T1, 70.0), _z(T2, 64.0)], "heating", 3.0) == {}
    # Inside the limit, or ahead rather than behind.
    assert zb.decide([_z(T1, 70.0, True), _z(T2, 67.0)], "heating", 3.0) == {}
    assert zb.decide([_z(T1, 70.0, True), _z(T2, 76.0)], "heating", 3.0) == {}
    # No reading on either side of the comparison.
    assert zb.decide([_z(T1, None, True), _z(T2, 64.0)], "heating", 3.0) == {}
    assert zb.decide([_z(T1, 70.0, True), _z(T2, None)], "heating", 3.0) == {}
    assert zb.spread([_z(T1, 70.0), _z(T2, None)]) is None


pytestmark = pytest.mark.asyncio


@pytest.fixture
async def site(client, fake_ha):
    rooms = {}
    for tid, room in ((T1, "Kitchen"), (T2, "Bunk Room"), (T3, "Den")):
        fake_ha.seed_state(tid, "heat", {"current_temperature": 70, "hvac_action": "idle"})
        resp = await client.post("/api/rooms", json={"name": room, "thermostat_entity_id": tid})
        assert resp.status == 201, await resp.text()
        rooms[tid] = (await resp.json())["id"]
    main = (await (await client.post("/api/buildings", json={"name": "Main House"})).json())["id"]
    for tid in (T1, T2):
        resp = await client.put(f"/api/zones/{tid}", json={"building_id": main})
        assert resp.status == 200, await resp.text()
    scheduler = client.app["scheduler"]
    await scheduler._sync_engines()
    await scheduler._load_heat_pumps()
    temps = {T1: 70.0, T2: 64.0, T3: 60.0}
    for tid, engine in scheduler._engines.items():
        engine._get_avg_temp = lambda _room, tid=tid, **_k: temps[tid]
    return main, rooms, temps


async def _set(client, building_id, **body):
    resp = await client.put(f"/api/zone-balance/{building_id}", json=body)
    assert resp.status == 200, await resp.text()
    return (await resp.json())["buildings"][0]


async def _events(client) -> list[str]:
    conn = await client.app["scheduler"].get_db()
    async with conn.execute(
        "SELECT message FROM event_log WHERE message LIKE 'Zone Balance:%' ORDER BY rowid"
    ) as cur:
        return [r["message"] for r in await cur.fetchall()]


async def test_off_by_default_and_the_section_shows_how_far_apart_the_zones_are(client, site):
    main, _rooms, _temps = site
    snap = await (await client.get("/api/zone-balance")).json()
    assert (snap["min_gap"], snap["max_gap"]) == (2.0, 10.0)
    (building,) = snap["buildings"]  # the den is in no building
    assert building == {
        "building_id": main,
        "name": "Main House",
        "level": "off",
        "zone_gap": 3.0,
        "direction": None,
        "spread": 6.0,
        "zones": [
            {
                "thermostat_entity_id": tid,
                "name": tid,
                "temp": temp,
                "occupied": False,
                "target": None,
                "toward": None,
                "obeyed": False,
                "answering": False,
            }
            for tid, temp in ((T1, 70.0), (T2, 64.0))
        ],
    }
    assert client.app["scheduler"].balance_calls == {}


async def test_an_occupied_zone_brings_a_lagging_one_to_within_the_limit(client, site):
    main, rooms, temps = site
    scheduler = client.app["scheduler"]
    await _set(client, main, level="on")
    # Nobody home and no direction: nothing.
    assert scheduler.balance_calls == {}
    # Someone holds the kitchen, and the building is heating.
    resp = await client.post(
        f"/api/rooms/{rooms[T1]}/override", json={"target_temp": 70, "duration_hours": 2}
    )
    assert resp.status in (200, 201), await resp.text()
    resp = await client.put(f"/api/building-modes/{main}", json={"mode": "heat_only"})
    assert resp.status == 200
    assert scheduler.balance_calls == {T2: (zb.Call("heating", 67.0, T1, 6.0), True)}
    assert scheduler._balance_call(T2) == zb.Call("heating", 67.0, T1, 6.0)
    assert scheduler._balance_call(T1) is None
    from backend.engine.cycle_engine import CycleState
    from backend.engine.room_manager import ActiveRoom

    south = scheduler._engines[T2]
    conn = await scheduler.get_db()
    south._active_rooms = {
        rooms[T2]: ActiveRoom(
            room=await db.get_room(conn, rooms[T2]), target_temp=67.0, source="balance"
        )
    }
    south._state = CycleState.IDLE
    assert not scheduler.balance_answering(T2)  # asked, but nothing is running
    south._state = CycleState.RUNNING
    assert scheduler.balance_answering(T2) and not scheduler.balance_answering("climate.nope")
    snap = (await (await client.get("/api/zone-balance")).json())["buildings"][0]
    assert [z["answering"] for z in snap["zones"]] == [False, True]
    south._state, south._active_rooms = CycleState.IDLE, {}
    assert snap["direction"] == "heating"
    assert [(z["occupied"], z["target"], z["toward"], z["obeyed"]) for z in snap["zones"]] == [
        (True, None, None, False),
        (False, 67.0, T1, True),
    ]
    # Said once, however many minutes it lasts.
    await scheduler._plan_zone_balance()
    assert await _events(client) == [
        f"Zone Balance: {T2} is 6°F colder than {T1}; it is asked to heat to 67°F"
    ]
    # Caught up: the call ends, and the next one is said again.
    temps[T2] = 67.5
    await scheduler._plan_zone_balance()
    assert scheduler.balance_calls == {}
    temps[T2] = 64.0
    await scheduler._plan_zone_balance()
    assert len(await _events(client)) == 2


async def test_watching_only_says_what_it_would_do_and_gives_the_zone_nothing(client, site):
    main, rooms, _temps = site
    scheduler = client.app["scheduler"]
    await client.post(
        f"/api/rooms/{rooms[T1]}/override", json={"target_temp": 70, "duration_hours": 2}
    )
    await client.put(f"/api/building-modes/{main}", json={"mode": "heat_only"})
    snap = await _set(client, main, level="watch", zone_gap=4)
    assert (snap["level"], snap["zone_gap"]) == ("watch", 4.0)
    assert scheduler.balance_calls == {T2: (zb.Call("heating", 66.0, T1, 6.0), False)}
    assert scheduler._balance_call(T2) is None
    assert await _events(client) == [
        f"Zone Balance: {T2} is 6°F colder than {T1}; it would be asked (watching only) to heat to 66°F"
    ]


async def test_the_direction_comes_from_running_zones_when_the_building_has_no_side(client, site):
    main, _rooms, _temps = site
    scheduler = client.app["scheduler"]
    tids = [T1, T2]
    assert scheduler.building_direction(tids) is None
    from backend.engine.cycle_engine import CycleState

    one, two = scheduler._engines[T1], scheduler._engines[T2]
    one._state, one._cycle_mode = CycleState.RUNNING, "cooling"
    assert scheduler.building_direction(tids) == "cooling"
    two._state, two._cycle_mode = CycleState.RUNNING, "heating"
    assert scheduler.building_direction(tids) is None  # they disagree
    # A side that is only being watched is not the way the building is working.
    two._state = CycleState.IDLE
    scheduler._building_side = lambda _tid: ("heating", False)
    assert scheduler.building_direction(tids) == "cooling"
    scheduler._building_side = lambda _tid: ("heating", True)
    assert scheduler.building_direction(tids) == "heating"
    del scheduler._building_side
    one._state = two._state = CycleState.IDLE
    await client.put(f"/api/building-modes/{main}", json={"mode": "off"})
    assert scheduler.building_direction(tids) is None


async def test_rooms_not_in_use_or_by_a_lit_fire_do_not_count_toward_a_zones_temperature(
    client, site, monkeypatch
):
    _main, rooms, _temps = site
    scheduler = client.app["scheduler"]
    assert (await scheduler.zone_states())[T2].temp == 64.0
    monkeypatch.setattr(scheduler._fireplaces, "set_aside_rooms", lambda: {rooms[T2]})
    assert (await scheduler.zone_states())[T2].temp is None
    monkeypatch.undo()
    resp = await client.put(f"/api/house/rooms/{rooms[T2]}", json={"in_use": False})
    assert resp.status == 200, await resp.text()
    assert (await scheduler.zone_states())[T2].temp is None


async def test_the_gap_is_a_difference_in_the_houses_unit(client, site):
    main, _rooms, _temps = site
    scheduler = client.app["scheduler"]
    scheduler._active_unit = "C"
    try:
        snap = await _set(client, main, zone_gap=2)  # 2 °C apart is 3.6 °F
        assert snap["zone_gap"] == 3.6
    finally:
        scheduler._active_unit = "F"


async def test_bad_requests_are_refused_with_fixed_messages(client, site):
    main, _rooms, _temps = site
    for body, message in (
        ({"level": "maybe"}, zb.BAD_LEVEL),
        ({"zone_gap": 1}, zb.BAD_GAP),
        ({"zone_gap": 11}, zb.BAD_GAP),
        ({"zone_gap": True}, zb.BAD_GAP),
        ({"zone_gap": "3"}, zb.BAD_GAP),
        ({"mode": "auto"}, zb.UNKNOWN_FIELD),
    ):
        resp = await client.put(f"/api/zone-balance/{main}", json=body)
        assert (resp.status, (await resp.json())["error"]) == (400, message), body
    resp = await client.put("/api/zone-balance/nope", json={"level": "on"})
    assert (resp.status, (await resp.json())["error"]) == (404, zb.BUILDING_UNKNOWN)


async def test_a_fault_while_planning_leaves_no_calls_and_does_not_stop_the_minute(
    client, site, monkeypatch
):
    main, _rooms, _temps = site
    scheduler = client.app["scheduler"]
    scheduler._balance_calls = {T2: (zb.Call("heating", 67.0, T1, 6.0), True)}

    async def broken(_conn):
        raise RuntimeError("boom")

    monkeypatch.setattr(zb, "load", broken)
    await scheduler._plan_zone_balance()
    assert scheduler.balance_calls == {}
    # A change that cannot be applied at once is still saved.
    monkeypatch.undo()
    monkeypatch.setattr(scheduler, "replan_buildings_now", broken)
    resp = await client.put(f"/api/zone-balance/{main}", json={"level": "on"})
    assert resp.status == 200


async def test_a_real_balancing_run_ends_by_itself_when_its_call_lapses(client, fake_ha, tick):
    """With real engines and a real cycle: no abort, and the minimum runtime is kept."""
    north, south = "climate.bal_north", "climate.bal_south"
    rooms = {}
    for tid, name, temp in ((north, "Kitchen", "70.0"), (south, "Bunk Room", "64.0")):
        slug = name.split()[0].lower()
        fake_ha.seed_state(
            tid,
            "heat",
            {"current_temperature": float(temp), "temperature": 60.0, "hvac_action": "idle"},
        )
        fake_ha.seed_state(f"sensor.bal_{slug}", temp, {"unit_of_measurement": "°F"})
        fake_ha.seed_state(f"cover.bal_{slug}", "open", {})
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": tid})
        rooms[tid] = (await resp.json())["id"]
        await client.post(
            f"/api/rooms/{rooms[tid]}/sensors", json={"entity_id": f"sensor.bal_{slug}"}
        )
        await client.post(
            f"/api/rooms/{rooms[tid]}/vents",
            json={"entity_id": f"cover.bal_{slug}", "control_method": "open_close"},
        )
        await client.put(f"/api/thermostats/{tid}", json={"min_cycle_runtime_min": 15})
    main = (await (await client.post("/api/buildings", json={"name": "Main House"})).json())["id"]
    for tid in (north, south):
        await client.put(f"/api/zones/{tid}", json={"building_id": main})
    await client.put(f"/api/building-modes/{main}", json={"mode": "heat_only"})
    await client.post(
        f"/api/rooms/{rooms[north]}/override", json={"target_temp": 70, "duration_hours": 8}
    )
    await _set(client, main, level="on")
    await tick()
    await tick()
    scheduler = client.app["scheduler"]
    eng = scheduler._engines[south]
    assert eng.cycle_state.value == "running"
    assert [ar.source for ar in eng._active_rooms.values()] == ["balance"]
    assert scheduler.balance_answering(south) and eng.balance_rooms == [rooms[south]]
    # The room arrives: the zones are inside the limit and the call lapses.
    await fake_ha.set_entity_state("sensor.bal_bunk", "67.2", {"unit_of_measurement": "°F"})
    await tick()
    await tick()
    assert scheduler.balance_calls == {}
    assert eng.cycle_state.value != "idle" and eng._cycle_log.in_min_runtime_hold is True
    # Once the minimum runtime has passed, it ends as any run does.
    eng._cycle_log.started_at -= timedelta(minutes=16)
    await tick()
    assert eng.cycle_state.value == "idle" and eng.balance_rooms == []
    conn = await scheduler.get_db()
    async with conn.execute(
        "SELECT ended_reason FROM cycle_logs WHERE thermostat_entity_id = ?", (south,)
    ) as cur:
        reasons = [r["ended_reason"] for r in await cur.fetchall()]
    assert len(reasons) == 1 and not str(reasons[0]).startswith("aborted")


@pytest.mark.parametrize("ambient", [66.0, 70.0, 72.0, 73.4, 76.0, 78.0])
async def test_a_hold_in_the_lagging_zone_is_served_whatever_the_thermostat_reads(
    client, fake_ha, tick, ambient
):
    """One room held at 74 °F and reading 80; two more, at 66, called to heat for balance.

    With real engines, and the building's direction coming from the other
    zone's heating run: the zone must never heat for the balancing rooms while
    the hold wants cooling, at any thermostat reading.
    """
    lead, lag = "climate.bal2_lead", "climate.bal2_lag"
    ids = {}
    for tid, name, temp in (
        (lead, "kitchen", "77.0"),
        (lag, "hot", "80.0"),
        (lag, "one", "66.0"),
        (lag, "two", "66.0"),
    ):
        amb = 77.0 if tid == lead else ambient
        fake_ha.seed_state(
            tid,
            "heat_cool",
            {"current_temperature": amb, "temperature": amb, "hvac_action": "idle"},
        )
        fake_ha.seed_state(f"sensor.bal2_{name}", temp, {"unit_of_measurement": "°F"})
        fake_ha.seed_state(f"cover.bal2_{name}", "open", {})
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": tid})
        ids[name] = (await resp.json())["id"]
        await client.post(
            f"/api/rooms/{ids[name]}/sensors", json={"entity_id": f"sensor.bal2_{name}"}
        )
        await client.post(
            f"/api/rooms/{ids[name]}/vents",
            json={"entity_id": f"cover.bal2_{name}", "control_method": "open_close"},
        )
    main = (await (await client.post("/api/buildings", json={"name": "Main House"})).json())["id"]
    for tid in (lead, lag):
        await client.put(f"/api/zones/{tid}", json={"building_id": main})
    await client.post(
        f"/api/rooms/{ids['kitchen']}/override", json={"target_temp": 80, "duration_hours": 8}
    )
    await client.post(
        f"/api/rooms/{ids['hot']}/override", json={"target_temp": 74, "duration_hours": 8}
    )
    scheduler = client.app["scheduler"]
    await tick()  # the other zone starts heating: that is the building's direction
    assert scheduler._engines[lead].cycle_mode == "heating"
    await _set(client, main, level="on")
    await tick()
    await tick()
    eng = scheduler._engines[lag]
    # Asked to heat for balance, unless it is already cooling for the hold.
    assert lag in scheduler.balance_calls or eng.cycle_mode == "cooling"
    assert eng.cycle_mode != "heating"
    assert all(ar.source != "balance" for ar in eng._active_rooms.values())


async def test_a_hold_that_arrives_during_a_balancing_run_ends_it(client, fake_ha, tick):
    """A run for nothing but balancing rooms does not keep a hold waiting."""
    lead, lag = "climate.bal3_lead", "climate.bal3_lag"
    ids = {}
    for tid, name, temp in (
        (lead, "kitchen", "77.0"),
        (lag, "hot", "80.0"),
        (lag, "one", "66.0"),
    ):
        amb = 77.0 if tid == lead else 70.0
        fake_ha.seed_state(
            tid,
            "heat_cool",
            {"current_temperature": amb, "temperature": amb, "hvac_action": "idle"},
        )
        fake_ha.seed_state(f"sensor.bal3_{name}", temp, {"unit_of_measurement": "°F"})
        fake_ha.seed_state(f"cover.bal3_{name}", "open", {})
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": tid})
        ids[name] = (await resp.json())["id"]
        await client.post(
            f"/api/rooms/{ids[name]}/sensors", json={"entity_id": f"sensor.bal3_{name}"}
        )
        await client.post(
            f"/api/rooms/{ids[name]}/vents",
            json={"entity_id": f"cover.bal3_{name}", "control_method": "open_close"},
        )
    main = (await (await client.post("/api/buildings", json={"name": "Main House"})).json())["id"]
    for tid in (lead, lag):
        await client.put(f"/api/zones/{tid}", json={"building_id": main})
    await client.post(
        f"/api/rooms/{ids['kitchen']}/override", json={"target_temp": 80, "duration_hours": 8}
    )
    await tick()
    await _set(client, main, level="on")
    await tick()
    eng = client.app["scheduler"]._engines[lag]
    assert [ar.source for ar in eng._active_rooms.values()] == ["balance"]
    await client.post(
        f"/api/rooms/{ids['hot']}/override", json={"target_temp": 74, "duration_hours": 8}
    )
    await tick()
    await tick()
    assert all(ar.source != "balance" for ar in eng._active_rooms.values())
    assert eng.cycle_mode != "heating"


@pytest.mark.parametrize("floor", [False, True])
async def test_a_finished_room_does_not_keep_a_run_going_for_balancing_rooms(
    client, fake_ha, tick, floor
):
    """Hold A is served and done; a balancing room is still short; hold B wants cooling.

    With real engines. The heating run must end for B as it would with Zone
    Balance off, including when the airflow floor keeps A's vent open so that
    it is never marked closed.
    """
    lead, lag = "climate.bal4_lead", "climate.bal4_lag"
    ids = {}
    for tid, name, temp in (
        (lead, "kitchen", "77.0"),
        (lag, "a", "66.0"),
        (lag, "x", "64.0"),
        (lag, "b", "70.0"),
    ):
        amb = 77.0 if tid == lead else 68.0
        fake_ha.seed_state(
            tid,
            "heat_cool",
            {"current_temperature": amb, "temperature": amb, "hvac_action": "idle"},
        )
        fake_ha.seed_state(f"sensor.bal4_{name}", temp, {"unit_of_measurement": "°F"})
        fake_ha.seed_state(f"cover.bal4_{name}", "open", {})
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": tid})
        ids[name] = (await resp.json())["id"]
        await client.post(
            f"/api/rooms/{ids[name]}/sensors", json={"entity_id": f"sensor.bal4_{name}"}
        )
        await client.post(
            f"/api/rooms/{ids[name]}/vents",
            json={"entity_id": f"cover.bal4_{name}", "control_method": "open_close"},
        )
    if floor:
        resp = await client.put(
            f"/api/thermostats/{lag}",
            json={"total_vents_count": 3, "min_open_vents_fraction": 0.75},
        )
        assert resp.status == 200, await resp.text()
    main = (await (await client.post("/api/buildings", json={"name": "Main House"})).json())["id"]
    for tid in (lead, lag):
        await client.put(f"/api/zones/{tid}", json={"building_id": main})
    for name, target in (("kitchen", 80), ("a", 70)):
        await client.post(
            f"/api/rooms/{ids[name]}/override", json={"target_temp": target, "duration_hours": 8}
        )
    await tick()
    await _set(client, main, level="on")
    await tick()
    await tick()
    eng = client.app["scheduler"]._engines[lag]
    assert eng.cycle_mode == "heating"
    assert {ar.source for ar in eng._active_rooms.values()} == {"override", "balance"}
    # A arrives; B is now hot and held to 72 °F.
    await fake_ha.set_entity_state("sensor.bal4_a", "70.2", {"unit_of_measurement": "°F"})
    await fake_ha.set_entity_state("sensor.bal4_b", "80.0", {"unit_of_measurement": "°F"})
    await client.post(
        f"/api/rooms/{ids['b']}/override", json={"target_temp": 72, "duration_hours": 8}
    )
    for _ in range(4):
        await tick()
    assert eng.cycle_mode != "heating"
    assert all(ar.source != "balance" for ar in eng._active_rooms.values())
