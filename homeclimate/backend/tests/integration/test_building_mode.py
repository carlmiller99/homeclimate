"""Building mode: one side per building, and when Auto switches it."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import building_mode as bm
from backend import forecast, house

pytestmark = pytest.mark.asyncio

T1, T2, T3 = "climate.north", "climate.south", "climate.den"
NOW = datetime(2026, 1, 5, 18, 0, tzinfo=UTC)


@pytest.fixture
async def site(client, fake_ha):
    for tid, room in ((T1, "Kitchen"), (T2, "Bunk Room"), (T3, "Den")):
        fake_ha.seed_state(tid, "heat", {"current_temperature": 70, "hvac_action": "idle"})
        resp = await client.post("/api/rooms", json={"name": room, "thermostat_entity_id": tid})
        assert resp.status == 201, await resp.text()
    main = (await (await client.post("/api/buildings", json={"name": "Main House"})).json())["id"]
    for tid in (T1, T2):
        resp = await client.put(f"/api/zones/{tid}", json={"building_id": main})
        assert resp.status == 200, await resp.text()
    return main


def _zone(tid: str, running: str | None = None, wants: str | None = None, **wait) -> bm.ZoneNow:
    w = None
    if wants:
        w = {
            "direction": wants,
            "since": NOW - timedelta(minutes=30),
            "excess": 0.5,
            "obeyed": True,
        }
        w.update(wait)
    return bm.ZoneNow(tid, running, w)


async def _plan(client, zones_now, *, now=NOW, hours=(), band=None):
    conn = await client.app["scheduler"].get_db()
    planner = client.app["scheduler"].building_plan
    switched = await planner.plan(conn, list(zones_now), list(hours), band, now)
    return planner, switched


async def _mode(client, building_id, **body):
    resp = await client.put(f"/api/building-modes/{building_id}", json=body)
    assert resp.status == 200, await resp.text()
    return (await resp.json())["buildings"][0]


async def test_by_default_zones_choose_for_themselves(client, site):
    snap = (await (await client.get("/api/building-modes")).json())["buildings"]
    assert snap == [
        {
            "building_id": site,
            "name": "Main House",
            "mode": "auto",
            "auto_level": "off",
            "side": None,
            "obey": False,
            "note": "",
            "waiting": [],
        }
    ]
    planner, switched = await _plan(client, [_zone(T1, "heating"), _zone(T2, wants="cooling")])
    assert switched == []
    assert planner.side_for(T1) == (None, False)
    assert planner.side_for(T3) == (None, False)  # in no building


async def test_fixed_modes_hold_every_zone_to_one_side(client, site):
    for mode, side in (("heat_only", "heating"), ("cool_only", "cooling"), ("off", "off")):
        got = await _mode(client, site, mode=mode)
        assert (got["mode"], got["side"], got["obey"]) == (mode, side, True)
        planner = client.app["scheduler"].building_plan
        assert planner.side_for(T1) == (side, True)
        assert planner.side_for(T2) == (side, True)
        assert planner.side_for(T3) == (None, False)


async def test_auto_takes_the_side_of_the_first_cycle_and_watch_only_never_holds(client, site):
    await _mode(client, site, auto_level="watch")
    planner, switched = await _plan(client, [_zone(T1), _zone(T2)])
    assert planner.side_for(T1) == (None, False)
    assert planner.decisions()[site].note == "Not on a side yet"
    # Two zones running opposite ways settle nothing.
    planner, switched = await _plan(client, [_zone(T1, "heating"), _zone(T2, "cooling")])
    assert switched == []
    planner, switched = await _plan(client, [_zone(T1, "heating"), _zone(T2)])
    assert switched == [(site, "heating")]
    assert planner.side_for(T2) == ("heating", False)  # watching: shown, not obeyed
    await _mode(client, site, auto_level="on")
    assert client.app["scheduler"].building_plan.side_for(T2) == ("heating", True)


async def _on_heating(client, site, at=NOW - timedelta(hours=5)):
    await _mode(client, site, auto_level="on")
    _planner, switched = await _plan(client, [_zone(T1, "heating")], now=at)
    assert switched == [(site, "heating")]


async def test_auto_switches_only_when_every_condition_holds(client, site):
    await _on_heating(client, site)

    async def note(zones_now, **kw) -> str:
        planner, switched = await _plan(client, zones_now, **kw)
        assert switched == []
        assert planner.side_for(T1) == ("heating", True)
        return str(planner.decisions()[site].note)

    assert await note([_zone(T1), _zone(T2)]) == ""
    # A cycle on the current side is still running.
    assert await note([_zone(T1, "heating"), _zone(T2, wants="cooling")]) == (
        "Waiting for heating to finish"
    )
    # The zone has only just started waiting.
    just = {"since": NOW - timedelta(minutes=3)}
    assert await note([_zone(T2, wants="cooling", **just)]) == (
        "A zone wants cooling; waiting 10 minutes"
    )
    # Too soon after the last switch.
    early = NOW - timedelta(hours=4)
    waited = {"since": early - timedelta(minutes=30)}
    assert await note([_zone(T2, wants="cooling", **waited)], now=early) == (
        "A zone wants cooling; 181 min until a switch is allowed"
    )
    # The forecast does not call for it.
    cold = [forecast.Hour(NOW + timedelta(hours=i), 40.0, None, None, "") for i in range(8)]
    assert await note([_zone(T2, wants="cooling")], hours=cold) == (
        "A zone wants cooling; the forecast does not call for it"
    )

    # Everything holds (two warm hours in the next six): it switches, once.
    warm = cold[:2] + [
        forecast.Hour(NOW + timedelta(hours=i), 80.0, None, None, "") for i in (2, 3)
    ]
    planner, switched = await _plan(client, [_zone(T2, wants="cooling")], hours=warm)
    assert switched == [(site, "cooling")]
    assert planner.side_for(T1) == ("cooling", True)
    planner, switched = await _plan(client, [_zone(T2)], hours=warm)
    assert switched == []


async def test_the_house_band_sets_what_the_forecast_counts_as_needing_a_side():
    hours = [forecast.Hour(NOW + timedelta(hours=i), 66.0, None, None, "") for i in range(6)]
    assert bm.forecast_wants(hours, "heating", None, NOW) is False  # default: below 60
    assert bm.forecast_wants(hours, "cooling", None, NOW) is False  # default: above 70
    band = house.Band(68.0, 74.0)
    assert bm.forecast_wants(hours, "heating", band, NOW) is True
    assert bm.forecast_wants(hours, "cooling", house.Band(60.0, 65.0), NOW) is True
    assert bm.forecast_wants([], "cooling", band, NOW) is None
    assert bm.forecast_wants(hours, "cooling", band, NOW + timedelta(days=2)) is None


async def test_no_more_than_two_switches_a_day_unless_a_room_is_far_out(client, site):
    await _on_heating(client, site, at=NOW - timedelta(hours=20))
    first = NOW - timedelta(hours=9)
    _p, switched = await _plan(
        client, [_zone(T2, wants="cooling", since=first - timedelta(minutes=30))], now=first
    )
    assert switched == [(site, "cooling")]
    late = {"since": NOW - timedelta(hours=5)}
    _p, switched = await _plan(
        client, [_zone(T2, wants="heating", **late)], now=NOW - timedelta(hours=4, minutes=30)
    )
    assert switched == [(site, "heating")]
    # A third switch the same day is refused…
    planner, switched = await _plan(client, [_zone(T2, wants="cooling")])
    assert switched == []
    assert planner.decisions()[site].note == "A zone wants cooling; already switched twice today"
    # …unless a room is 2 °F past its target, which switches at once.
    planner, switched = await _plan(
        client, [_zone(T2, wants="cooling", excess=2.0, since=NOW - timedelta(minutes=1))]
    )
    assert switched == [(site, "cooling")]
    # Even then a cycle still running on the old side is allowed to finish first.
    planner, switched = await _plan(
        client,
        [_zone(T1, "cooling"), _zone(T2, wants="heating", excess=5.0)],
        now=NOW + timedelta(minutes=5),
    )
    assert switched == []
    # The count starts again the next day.
    planner, switched = await _plan(
        client, [_zone(T2, wants="heating")], now=NOW + timedelta(days=1)
    )
    assert switched == [(site, "heating")]


async def test_the_side_survives_a_restart(client, site):
    await _on_heating(client, site)
    scheduler = client.app["scheduler"]
    scheduler._building_plan = bm.Planner()
    assert scheduler.building_plan.side_for(T1) == (None, False)
    await scheduler._plan_buildings()
    assert scheduler.building_plan.side_for(T1) == ("heating", True)


async def test_the_api_reports_waiting_zones_and_logs_switches(client, site):
    await _mode(client, site, auto_level="on")
    scheduler = client.app["scheduler"]
    engine = scheduler._engines[T2]
    engine.building_wait = {
        "direction": "cooling",
        "since": datetime.now(UTC) - timedelta(minutes=2),
        "excess": 0.4,
        "obeyed": True,
    }
    scheduler._engines[T1]._cycle_mode = "heating"
    from backend.engine.cycle_engine import CycleState

    scheduler._engines[T1]._state = CycleState.RUNNING
    try:
        await scheduler._plan_buildings()  # takes the running cycle's side
        await scheduler._plan_buildings()  # then sees the zone waiting for the other
        snap = (await (await client.get("/api/building-modes")).json())["buildings"][0]
    finally:
        scheduler._engines[T1]._state = CycleState.IDLE
        scheduler._engines[T1]._cycle_mode = None
        engine.building_wait = None
    assert (snap["side"], snap["obey"], snap["note"]) == (
        "heating",
        True,
        "Waiting for heating to finish",
    )
    assert [(w["thermostat_entity_id"], w["direction"], w["obeyed"]) for w in snap["waiting"]] == [
        (T2, "cooling", True)
    ]
    events = await (await client.get("/api/logs/events?category=engine")).json()
    assert "Main House is now on heating" in [e["message"] for e in events]


async def test_validation_and_failures(client, site, monkeypatch, caplog):
    url = f"/api/building-modes/{site}"
    for body, message in (
        ({"mode": "warm"}, "mode must be auto, heat_only, cool_only or off"),
        ({"auto_level": "yes"}, "auto_level must be off, watch or on"),
        ({"colour": "red"}, "Unknown building mode field"),
    ):
        resp = await client.put(url, json=body)
        assert (resp.status, (await resp.json())["error"]) == (400, message)
    resp = await client.put("/api/building-modes/nope", json={"mode": "off"})
    assert (resp.status, (await resp.json())["error"]) == (404, "Building not found")

    scheduler = client.app["scheduler"]

    async def boom(*_a, **_k):
        raise RuntimeError("db gone")

    monkeypatch.setattr(scheduler.building_plan, "plan", boom)
    await scheduler._plan_buildings()
    assert "Could not plan building modes" in caplog.text
    monkeypatch.setattr(scheduler, "replan_buildings_now", boom)
    assert (await client.put(url, json={"mode": "off"})).status == 200
    assert "Could not apply the building mode straight away" in caplog.text
