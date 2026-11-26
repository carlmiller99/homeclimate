"""Get Rooms Ready for Usual Arrivals, with real engines and real cycles."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import arrivals, suggestions, tz

from .test_suggestions import NOW, _occupancy

pytestmark = pytest.mark.asyncio

T = "climate.arr_zone"


@pytest.fixture(autouse=True)
def utc(monkeypatch):
    monkeypatch.setattr(tz, "get_timezone", lambda: UTC)


async def _site(client, fake_ha, monkeypatch, rooms, *, ambient=66.0, level=2):
    """A zone whose rooms are each usually used from ten minutes from now."""
    fake_ha.seed_state(
        T,
        "heat_cool",
        {"current_temperature": ambient, "temperature": ambient, "hvac_action": "idle"},
    )
    ids = {}
    for name, temp in rooms.items():
        fake_ha.seed_state(f"sensor.arr_{name}", str(temp), {"unit_of_measurement": "°F"})
        fake_ha.seed_state(f"cover.arr_{name}", "open", {})
        resp = await client.post(
            "/api/rooms",
            json={"name": name, "thermostat_entity_id": T, "system_wide_temp": 70},
        )
        assert resp.status == 201, await resp.text()
        ids[name] = (await resp.json())["id"]
        await client.post(
            f"/api/rooms/{ids[name]}/sensors", json={"entity_id": f"sensor.arr_{name}"}
        )
        await client.post(
            f"/api/rooms/{ids[name]}/vents",
            json={"entity_id": f"cover.arr_{name}", "control_method": "open_close"},
        )
    await client.put(f"/api/thermostats/{T}", json={"min_cycle_runtime_min": 15})
    resp = await client.put("/api/learning/settings", json={"arrival_level": level})
    assert resp.status == 200, await resp.text()

    def soon(usual, local_now):
        if not usual:
            return None
        return local_now.replace(second=0, microsecond=0) + timedelta(minutes=10), 600.0

    monkeypatch.setattr(arrivals, "next_arrival", soon)
    scheduler = client.app["scheduler"]
    await scheduler._sync_engines()
    engine = scheduler._engines[T]

    async def usual_hours(_conn, room_ids, _now):
        return {rid: frozenset({(0, 0)}) for rid in room_ids if rid != ids.get("spare")}

    monkeypatch.setattr(suggestions, "usual_hours", usual_hours)
    return ids, engine


async def test_usual_hours_come_from_the_rooms_own_occupancy_history(client, fake_ha):
    fake_ha.seed_state(T, "heat", {"current_temperature": 70, "hvac_action": "idle"})
    resp = await client.post("/api/rooms", json={"name": "Bunk Room", "thermostat_entity_id": T})
    room = (await resp.json())["id"]
    conn = await client.app["scheduler"].get_db()
    assert await suggestions.usual_hours(conn, [room, "gone"], NOW) == {}
    await _occupancy(conn, room, days=21, hours=(8, 9))
    found = await suggestions.usual_hours(conn, [room, "gone"], NOW)
    assert found == {room: frozenset((day, hour) for day in range(5) for hour in (8, 9))}
    assert arrivals.next_arrival(found[room], datetime(2026, 3, 30, 7, 45)) == (
        datetime(2026, 3, 30, 8, 0),
        900.0,
    )


async def test_the_setting_is_checked_and_off_to_begin_with(client):
    body = await (await client.get("/api/learning")).json()
    assert body["settings"]["arrival_level"] == 0
    resp = await client.put("/api/learning/settings", json={"arrival_level": 3})
    assert resp.status == 400
    assert (await resp.json())["error"] == (
        "arrival_level must be 0 (off), 1 (watch only) or 2 (on)"
    )


async def test_a_room_is_warmed_before_its_usual_hour_and_the_run_ends_by_itself(
    client, fake_ha, tick, monkeypatch
):
    ids, eng = await _site(client, fake_ha, monkeypatch, {"bunk": 64.0, "spare": 64.0})
    await tick()
    await tick()
    assert eng.cycle_mode == "heating"
    assert {ar.room.name: ar.source for ar in eng._active_rooms.values()} == {"bunk": "arrival"}
    assert eng.arrival_rooms == [ids["bunk"]]
    status = await (await client.get("/api/status")).json()
    zone = next(z for z in status if z["thermostat_entity_id"] == T)
    assert zone["arrival_rooms"] == [ids["bunk"]]
    # The room arrives at its temperature; once the minimum runtime has passed
    # the run ends as any run does, and is not started again.
    fake_ha.seed_state("sensor.arr_bunk", "70.2", {"unit_of_measurement": "°F"})
    await tick()
    eng._cycle_log.started_at -= timedelta(minutes=16)
    await tick()
    await tick()
    assert eng.cycle_state.value == "idle" and eng.arrival_rooms == []
    conn = await client.app["scheduler"].get_db()
    async with conn.execute(
        "SELECT ended_reason FROM cycle_logs WHERE thermostat_entity_id = ?", (T,)
    ) as cur:
        reasons = [r["ended_reason"] for r in await cur.fetchall()]
    assert len(reasons) == 1 and not str(reasons[0]).startswith("aborted")


@pytest.mark.parametrize("why", ["nobody came", "switched off"])
async def test_a_run_for_an_empty_room_is_wound_up_not_run_to_the_end(
    client, fake_ha, tick, monkeypatch, why
):
    ids, eng = await _site(client, fake_ha, monkeypatch, {"bunk": 64.0})
    await tick()
    await tick()
    assert eng.cycle_mode == "heating" and eng.arrival_rooms == [ids["bunk"]]
    # Still cold, and it stays in the run while the hour may yet be used.
    eng._cycle_log.started_at -= timedelta(minutes=16)
    await tick()
    assert eng.cycle_mode == "heating"
    if why == "nobody came":
        eng._arrival_until = {ids["bunk"]: datetime.now(UTC) - timedelta(minutes=1)}
        monkeypatch.setattr(arrivals, "next_arrival", lambda _usual, _now: None)
    else:
        await client.put("/api/learning/settings", json={"arrival_level": 0})
    for _ in range(3):
        await tick()
    assert eng.cycle_state.value == "idle"
    conn = await client.app["scheduler"].get_db()
    async with conn.execute(
        "SELECT ended_reason FROM cycle_logs WHERE thermostat_entity_id = ?", (T,)
    ) as cur:
        reasons = [r["ended_reason"] for r in await cur.fetchall()]
    assert len(reasons) == 1 and not str(reasons[0]).startswith("aborted")
    # And it is not begun again for the same empty hour.
    for _ in range(2):
        await tick()
    assert eng.cycle_state.value == "idle"


async def test_watching_only_starts_nothing(client, fake_ha, tick, monkeypatch):
    _ids, eng = await _site(client, fake_ha, monkeypatch, {"bunk": 64.0}, level=1)
    await tick()
    await tick()
    assert eng.cycle_state.value == "idle" and eng._active_rooms == {}


@pytest.mark.parametrize("ambient", [60.0, 66.0, 70.0, 73.6, 76.0, 80.0])
async def test_a_room_being_got_ready_never_outvotes_a_hold(
    client, fake_ha, tick, monkeypatch, ambient
):
    """Whatever the thermostat reads, the zone does for the hold what it would with this off."""
    ids, eng = await _site(
        client, fake_ha, monkeypatch, {"held": 80.0, "bunk": 64.0}, ambient=ambient
    )
    await client.post(
        f"/api/rooms/{ids['held']}/override", json={"target_temp": 74, "duration_hours": 2}
    )
    await tick()
    await tick()
    # (Cooling, or nothing yet where the thermostat's own reading holds it back:
    # either way what the hold would get with this switched off.)
    assert eng.cycle_mode != "heating" and eng.arrival_rooms == []
    assert all(ar.source == "override" for ar in eng._active_rooms.values())


async def test_a_hold_that_arrives_mid_run_ends_a_run_for_arrivals_alone(
    client, fake_ha, tick, monkeypatch
):
    ids, eng = await _site(client, fake_ha, monkeypatch, {"held": 80.0, "bunk": 64.0})
    await tick()
    await tick()
    assert eng.cycle_mode == "heating" and eng.arrival_rooms == [ids["bunk"]]
    await client.post(
        f"/api/rooms/{ids['held']}/override", json={"target_temp": 74, "duration_hours": 2}
    )
    eng._cycle_log.started_at -= timedelta(minutes=16)
    await tick()
    await tick()
    await tick()
    # (Cooling, or nothing yet where the thermostat's own reading holds it back:
    # either way what the hold would get with this switched off.)
    assert eng.cycle_mode != "heating" and eng.arrival_rooms == []
    assert all(ar.source == "override" for ar in eng._active_rooms.values())
