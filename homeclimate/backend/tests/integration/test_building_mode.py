"""Building and zone modes: each zone's side, how often it may switch, and keeping zones apart."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import building_mode as bm
from backend import db, forecast, house

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


def _zone(
    tid: str,
    running: str | None = None,
    wants: str | None = None,
    *,
    in_use: bool = False,
    held_for: str | None = None,
    **wait,
) -> bm.ZoneNow:
    w = None
    if wants:
        w = {
            "direction": wants,
            "since": NOW - timedelta(minutes=30),
            "excess": 0.5,
            # Past the default switching threshold, unless a test says otherwise.
            "past": 5.0,
            "obeyed": True,
        }
        w.update(wait)
    return bm.ZoneNow(tid, running, w, False, in_use, held_for)


async def _plan(client, zones_now, *, now=NOW, hours=(), band=None):
    conn = await client.app["scheduler"].get_db()
    planner = client.app["scheduler"].building_plan
    switched = await planner.plan(conn, list(zones_now), list(hours), band, now)
    return planner, switched


async def _mode(client, building_id, **body):
    resp = await client.put(f"/api/building-modes/{building_id}", json=body)
    assert resp.status == 200, await resp.text()
    return (await resp.json())["buildings"][0]


async def _zone_mode(client, tid, mode):
    resp = await client.put(f"/api/zones/{tid}", json={"mode": mode})
    assert resp.status == 200, await resp.text()


async def _on_heating(client, tid=T1, at=NOW - timedelta(hours=5)):
    _planner, switched = await _plan(client, [_zone(tid, "heating")], now=at)
    assert switched == [(tid, "heating")]


def _note(planner, tid) -> str:
    return str(planner.decisions()[tid].note)


async def test_by_default_each_zone_in_a_building_chooses_its_own_side(client, site):
    snap = (await (await client.get("/api/building-modes")).json())["buildings"]
    assert [{k: v for k, v in b.items() if k != "zones"} for b in snap] == [
        {
            "building_id": site,
            "name": "Main House",
            "mode": "auto",
            "opposite_allowed": True,
            "switching": "often",
            "switch_threshold": 3.0,
        }
    ]
    assert [
        (z["thermostat_entity_id"], z["mode"], z["effective_mode"]) for z in snap[0]["zones"]
    ] == [
        (T1, "follow", "auto"),
        (T2, "follow", "auto"),
    ] or sorted(z["thermostat_entity_id"] for z in snap[0]["zones"]) == sorted([T1, T2])
    planner, switched = await _plan(client, [_zone(T1, "heating"), _zone(T2, "cooling")])
    # Each zone takes the side of its own first cycle.
    assert sorted(switched) == sorted([(T1, "heating"), (T2, "cooling")])
    assert planner.side_for(T1) == ("heating", True)
    assert planner.side_for(T2) == ("cooling", True)
    assert planner.side_for(T3) == (None, False)  # in no building: free
    # Zones may run opposite each other unless the building says not.
    assert planner.live_side(T1, {T2: "cooling"}) == ("heating", True)
    assert planner.claim(T1, "heating") is None


async def test_fixed_modes_and_a_zones_own_mode(client, site):
    for mode, side in (("heat_only", "heating"), ("cool_only", "cooling"), ("off", "off")):
        await _mode(client, site, mode=mode)
        planner = client.app["scheduler"].building_plan
        assert planner.side_for(T1) == (side, True)
        assert planner.side_for(T2) == (side, True)
        assert planner.side_for(T3) == (None, False)
        # A side that is a setting, which no waiting changes.
        assert planner.side_is_fixed(T1) is True
        assert planner.side_is_fixed(T3) is False
    # A zone's own mode wins over its building's.
    await _mode(client, site, mode="heat_only")
    await _zone_mode(client, T2, "cool")
    planner, _s = await _plan(client, [_zone(T1), _zone(T2)])
    assert planner.side_for(T1) == ("heating", True)
    assert planner.side_for(T2) == ("cooling", True)
    await _zone_mode(client, T2, "auto")
    planner, _s = await _plan(client, [_zone(T1), _zone(T2)])
    assert planner.side_for(T2) == (None, True)
    assert planner.side_is_fixed(T2) is False
    # A zone in no building can be set too; following, it stays free.
    await _zone_mode(client, T3, "off")
    planner, _s = await _plan(client, [_zone(T3)])
    assert planner.side_for(T3) == ("off", True)
    snap = (await (await client.get("/api/building-modes")).json())["buildings"][0]
    south = next(z for z in snap["zones"] if z["thermostat_entity_id"] == T2)
    assert (south["mode"], south["effective_mode"]) == ("auto", "auto")
    resp = await client.put(f"/api/zones/{T1}", json={"mode": "warm"})
    assert resp.status == 400


async def test_a_zone_switches_only_when_every_condition_holds(client, site):
    await _on_heating(client)

    async def note(zone, **kw) -> str:
        planner, switched = await _plan(client, [zone], **kw)
        assert switched == []
        assert planner.side_for(T1) == ("heating", True)
        return _note(planner, T1)

    assert await note(_zone(T1)) == ""
    # A cycle on its current side is still running.
    assert await note(_zone(T1, "heating", wants="cooling")) == "Waiting for heating to finish"
    # It has only just started waiting.
    just = {"since": NOW - timedelta(minutes=3)}
    assert await note(_zone(T1, wants="cooling", **just)) == "Wants cooling; waiting 10 minutes"
    # Too soon after its last switch.
    early = NOW - timedelta(hours=4)
    waited = {"since": early - timedelta(minutes=30)}
    assert await note(_zone(T1, wants="cooling", **waited), now=early) == (
        "Wants cooling; 3 hours until it may switch"
    )
    # The forecast does not call for it.
    cold = [forecast.Hour(NOW + timedelta(hours=i), 40.0, None, None, "") for i in range(8)]
    assert await note(_zone(T1, wants="cooling"), hours=cold) == (
        "Wants cooling; the forecast does not call for it"
    )
    # Everything holds (two warm hours in the next six): it switches, once.
    warm = cold[:2] + [
        forecast.Hour(NOW + timedelta(hours=i), 80.0, None, None, "") for i in (2, 3)
    ]
    planner, switched = await _plan(client, [_zone(T1, wants="cooling")], hours=warm)
    assert switched == [(T1, "cooling")]
    assert planner.side_for(T1) == ("cooling", True)
    # Another zone of the building is untouched.
    assert planner.side_for(T2)[0] is None
    planner, switched = await _plan(client, [_zone(T1)], hours=warm)
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


async def test_no_more_than_two_switches_a_day_however_far_out_a_room_is(client, site):
    await _on_heating(client, at=NOW - timedelta(hours=20))
    first = NOW - timedelta(hours=9)
    _p, switched = await _plan(
        client, [_zone(T1, wants="cooling", since=first - timedelta(minutes=30))], now=first
    )
    assert switched == [(T1, "cooling")]
    late = {"since": NOW - timedelta(hours=5)}
    _p, switched = await _plan(
        client, [_zone(T1, wants="heating", **late)], now=NOW - timedelta(hours=4, minutes=30)
    )
    assert switched == [(T1, "heating")]
    planner, switched = await _plan(client, [_zone(T1, wants="cooling", excess=9.0, past=9.5)])
    assert switched == []
    assert _note(planner, T1) == "Wants cooling; already switched twice today"
    later = NOW + timedelta(days=1)
    _p, switched = await _plan(
        client, [_zone(T1, wants="cooling", since=later - timedelta(minutes=30))], now=later
    )
    assert switched == [(T1, "cooling")]


async def test_the_side_survives_a_restart(client, site):
    await _on_heating(client)
    scheduler = client.app["scheduler"]
    scheduler._building_plan = bm.Planner()
    assert scheduler.building_plan.side_for(T1) == (None, False)
    await scheduler._plan_buildings()
    assert scheduler.building_plan.side_for(T1) == ("heating", True)


async def test_the_api_reports_each_zone_and_logs_switches(client, site):
    scheduler = client.app["scheduler"]
    await _mode(client, site, switching="daily")
    from backend.engine.cycle_engine import CycleState

    scheduler._engines[T1]._cycle_mode = "heating"
    scheduler._engines[T1]._state = CycleState.RUNNING
    engine = scheduler._engines[T1]
    try:
        await scheduler._plan_buildings()  # takes the running cycle's side
        engine.building_wait = {
            "direction": "cooling",
            "since": datetime.now(UTC) - timedelta(minutes=2),
            "excess": 0.4,
            "past": 5.0,
            "obeyed": True,
        }
        await scheduler._plan_buildings()  # then sees it waiting for the other
        snap = (await (await client.get("/api/building-modes")).json())["buildings"][0]
    finally:
        scheduler._engines[T1]._state = CycleState.IDLE
        scheduler._engines[T1]._cycle_mode = None
        engine.building_wait = None
    north = next(z for z in snap["zones"] if z["thermostat_entity_id"] == T1)
    assert (north["side"], north["note"], north["waiting"]) == (
        "heating",
        "Waiting for heating to finish",
        "cooling",
    )
    assert north["next_switch_at"] is not None
    south = next(z for z in snap["zones"] if z["thermostat_entity_id"] == T2)
    assert (south["side"], south["next_switch_at"], south["held_for"]) == (None, None, None)
    events = await (await client.get("/api/logs/events?category=engine")).json()
    assert any(e["message"].endswith("is now on heating") for e in events)


async def test_validation_and_failures(client, site, monkeypatch, caplog):
    url = f"/api/building-modes/{site}"
    for body, message in (
        ({"mode": "warm"}, "mode must be auto, heat_only, cool_only or off"),
        ({"opposite_allowed": "no"}, "opposite_allowed must be true or false"),
        ({"auto_level": "on"}, "Unknown building mode field"),
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


async def test_only_a_room_past_the_threshold_counts_toward_a_switch(client, site):
    await _on_heating(client)
    near = {"past": 2.9}
    planner, switched = await _plan(client, [_zone(T1, wants="cooling", **near)])
    assert switched == []
    assert _note(planner, T1) == "Wants cooling; no room is far enough past its target"
    # A wait that reports no distance from the target goes by how far past its
    # starting point the room is.
    old = _zone(T1, wants="cooling", excess=1.0)
    assert old.wait is not None
    del old.wait["past"]
    _p, switched = await _plan(client, [old])
    assert switched == []
    # A lower threshold lets the same room switch it. 1.5 °C is 2.7 °F.
    client.app["scheduler"]._active_unit = "C"
    try:
        got = await _mode(client, site, switch_threshold=1.5)
    finally:
        client.app["scheduler"]._active_unit = "F"
    assert got["switch_threshold"] == 2.7
    _p, switched = await _plan(client, [_zone(T1, wants="cooling", **near)])
    assert switched == [(T1, "cooling")]


@pytest.mark.parametrize(
    ("switching", "too_soon", "note", "allowed"),
    [
        ("daily", timedelta(hours=23), "61 min", timedelta(hours=24, minutes=1)),
        ("daily", timedelta(hours=10), "14 hours", timedelta(hours=24, minutes=1)),
        ("weekly", timedelta(days=6), "24 hours", timedelta(days=7, minutes=1)),
        ("monthly", timedelta(days=12), "18 days", timedelta(days=30, minutes=1)),
    ],
)
async def test_a_longer_limit_counts_from_the_last_switch(
    client, site, switching, too_soon, note, allowed
):
    start = NOW - timedelta(days=40)
    await _mode(client, site, switching=switching)
    _p, switched = await _plan(client, [_zone(T1, "heating")], now=start)
    assert switched == [(T1, "heating")]
    # The first side is not a switch on a weekly or monthly limit, so the
    # first real switch is free; from then on the limit runs.
    first = start + timedelta(days=1, minutes=5)
    wants = lambda at, side: [_zone(T1, wants=side, since=at - timedelta(minutes=30))]  # noqa: E731
    _p, switched = await _plan(client, wants(first, "cooling"), now=first)
    assert switched == [(T1, "cooling")]
    at = first + too_soon
    far = [_zone(T1, wants="heating", since=at - timedelta(minutes=30), past=12.0, excess=11.0)]
    planner, switched = await _plan(client, far, now=at)
    assert switched == []
    assert _note(planner, T1) == f"Wants heating; {note} until it may switch"
    at = first + allowed
    _p, switched = await _plan(client, wants(at, "heating"), now=at)
    assert switched == [(T1, "heating")]


async def test_a_daily_limit_counts_the_first_side_and_checks_the_next_hours(client, site):
    await _mode(client, site, switching="daily")
    await _on_heating(client)
    planner, switched = await _plan(client, [_zone(T1, wants="cooling")])
    assert switched == []
    assert "until it may switch" in _note(planner, T1)
    later = NOW + timedelta(hours=20)
    cold = [forecast.Hour(later + timedelta(hours=i), 40.0, None, None, "") for i in range(8)]
    waiting = [_zone(T1, wants="cooling", since=later - timedelta(minutes=30))]
    planner, switched = await _plan(client, waiting, now=later, hours=cold)
    assert switched == []
    assert _note(planner, T1) == "Wants cooling; the forecast does not call for it"
    _p, switched = await _plan(client, waiting, now=later)
    assert switched == [(T1, "cooling")]


async def test_a_seasonal_switch_needs_the_coming_days_to_favour_it(client, site):
    await _mode(client, site, switching="monthly")
    await _on_heating(client)

    def days(temps):
        return [
            forecast.Hour(NOW + timedelta(hours=i), temps[i * len(temps) // 72], None, None, "")
            for i in range(72)
        ]

    mostly_cold = days([40.0, 40.0, 80.0, 40.0, 40.0, 40.0])
    planner, switched = await _plan(client, [_zone(T1, wants="cooling")], hours=mostly_cold)
    assert switched == []
    assert _note(planner, T1) == "Wants cooling; the coming days' forecast does not favour it"
    assert bm.forecast_favours(mostly_cold[:10], "cooling", None, NOW) is None
    band = house.Band(68.0, 74.0)
    mild = days([66.0])
    assert bm.forecast_favours(mild, "heating", band, NOW) is True
    assert bm.forecast_favours(mild, "cooling", band, NOW) is False
    assert bm.forecast_favours(mild, "heating", None, NOW) is None
    assert bm.forecast_favours(mild, "cooling", None, NOW) is None
    mostly_warm = days([80.0, 80.0, 40.0, 80.0])
    _p, switched = await _plan(client, [_zone(T1, wants="cooling")], hours=mostly_warm)
    assert switched == [(T1, "cooling")]


async def test_a_reading_that_was_not_held_past_the_threshold_does_not_count(client, site):
    await _on_heating(client)
    planner, switched = await _plan(client, [_zone(T1, wants="cooling", past=4.5, held=1.0)])
    assert switched == []
    assert _note(planner, T1) == "Wants cooling; no room is far enough past its target"
    _p, switched = await _plan(client, [_zone(T1, wants="cooling", past=4.5, held=3.0)])
    assert switched == [(T1, "cooling")]


async def test_a_wait_for_its_own_side_or_none_changes_nothing(client, site):
    await _on_heating(client)
    planner, switched = await _plan(client, [_zone(T1, wants="heating")])
    assert switched == [] and _note(planner, T1) == ""


async def test_changing_the_limit_starts_every_zones_count_again(client, site):
    await _on_heating(client, at=NOW - timedelta(minutes=30))
    planner, _s = await _plan(client, [_zone(T1, wants="cooling")])
    assert "until it may switch" in _note(planner, T1)
    await _mode(client, site, switching="often")  # the same limit: nothing changes
    _p, switched = await _plan(client, [_zone(T1, wants="cooling")])
    assert switched == []
    await _mode(client, site, switching="monthly")
    _p, switched = await _plan(client, [_zone(T1, wants="cooling")])
    assert switched == [(T1, "cooling")]


async def test_switching_settings_are_checked_and_kept(client, site):
    got = await _mode(client, site, switching="weekly", switch_threshold=4)
    assert (got["switching"], got["switch_threshold"]) == ("weekly", 4.0)
    snap = await (await client.get("/api/building-modes")).json()
    assert (snap["min_threshold"], snap["max_threshold"]) == (0.0, 10.0)
    for body, text in (
        ({"switching": "yearly"}, bm.BAD_SWITCHING),
        ({"switch_threshold": 11}, bm.BAD_THRESHOLD),
        ({"switch_threshold": -1}, bm.BAD_THRESHOLD),
        ({"switch_threshold": True}, bm.BAD_THRESHOLD),
        ({"switch_threshold": "3"}, bm.BAD_THRESHOLD),
    ):
        resp = await client.put(f"/api/building-modes/{site}", json=body)
        assert resp.status == 400, body
        assert (await resp.json())["error"] == text
    client.app["scheduler"]._active_unit = "C"
    try:
        got = await _mode(client, site, switch_threshold=5.56)
    finally:
        client.app["scheduler"]._active_unit = "F"
    assert got["switch_threshold"] == 10.0
    await _mode(client, site, switch_threshold=4)
    got = await _mode(client, site, mode="heat_only", opposite_allowed=False)
    assert (got["switching"], got["switch_threshold"], got["opposite_allowed"]) == (
        "weekly",
        4.0,
        False,
    )


async def test_the_time_left_reads_in_the_unit_that_fits():
    assert bm._time_left(timedelta(minutes=44, seconds=10)) == "45 min"
    assert bm._time_left(timedelta(hours=1, minutes=58)) == "119 min"
    assert bm._time_left(timedelta(hours=2)) == "2 hours"
    assert bm._time_left(timedelta(hours=47, minutes=30)) == "48 hours"
    assert bm._time_left(timedelta(hours=48)) == "2 days"
    assert bm._time_left(timedelta(days=17, hours=1)) == "18 days"


async def test_a_clock_set_backwards_does_not_lock_a_zone(client, site):
    await _on_heating(client, at=NOW + timedelta(days=3))
    _p, switched = await _plan(client, [_zone(T1, wants="cooling")])
    assert switched == [(T1, "cooling")]


async def test_leaving_auto_forgets_the_side_it_was_on(client, site):
    await _on_heating(client)
    await _mode(client, site, mode="cool_only")
    planner, _s = await _plan(client, [_zone(T1)])
    assert planner.side_for(T1) == ("cooling", True)
    await _mode(client, site, mode="auto")
    planner, _s = await _plan(client, [_zone(T1)])
    assert planner.side_for(T1) == (None, True)
    # The same for a zone's own mode.
    await _on_heating(client)
    await _zone_mode(client, T1, "heat")
    await _plan(client, [_zone(T1)])
    await _zone_mode(client, T1, "follow")
    planner, _s = await _plan(client, [_zone(T1)])
    assert planner.side_for(T1) == (None, True)


async def test_a_mode_left_behind_by_a_removed_building_is_ignored(client, site):
    conn = await client.app["scheduler"].get_db()
    await conn.execute(
        "INSERT INTO building_modes(building_id, mode) VALUES('gone-building', 'off')"
    )
    await conn.commit()
    modes = await bm.load(conn)
    assert "gone-building" not in modes and len(modes) >= 1


async def test_a_protection_cycle_never_sets_or_switches_a_side(client, site):
    safety = bm.ZoneNow(T1, "cooling", None, True)
    planner, switched = await _plan(client, [safety])
    assert switched == [] and planner.side_for(T1) == (None, True)
    await _on_heating(client)
    planner, switched = await _plan(client, [safety], now=NOW + timedelta(minutes=30))
    assert switched == [] and planner.side_for(T1) == ("heating", True)


async def test_zones_kept_apart_never_start_opposite_each_other(client, site):
    planner = client.app["scheduler"].building_plan
    await _mode(client, site, opposite_allowed=False)
    await _on_heating(client)
    await _zone_mode(client, T2, "cool")
    planner, _s = await _plan(client, [_zone(T1), _zone(T2)])
    assert planner.keeps_apart(site) and not planner.keeps_apart(None)
    # A running cycle the other way holds a new start; its own does not.
    assert planner.live_side(T2, {T1: "heating"}) == ("hold", True)
    assert planner.live_side(T2, {T2: "cooling"}) == ("cooling", True)
    assert planner.live_side(T1, {T3: "cooling"}) == ("heating", True)  # another building
    assert planner.live_side(T3, {T1: "cooling"}) == (None, False)
    # Two idle zones cannot start opposite cycles in the same minute.
    assert planner.claim(T3, "cooling") is None  # in no building
    assert planner.claim(T2, "cooling") is None
    assert planner.claim(T1, "heating") == "hold"
    assert planner.claim(T1, "cooling") is None
    scheduler = client.app["scheduler"]
    assert scheduler._building_plan_claim(T1, "heating") == "hold"
    # A claim lasts until the next plan; one that came to nothing sits out a turn.
    planner, _s = await _plan(client, [_zone(T1), _zone(T2)])
    assert planner.claim(T2, "cooling") == "hold"
    assert planner.claim(T1, "heating") is None
    planner, _s = await _plan(client, [_zone(T1, "heating"), _zone(T2)])
    # Once T1 runs, what holds T2 is the running cycle, not a claim.
    assert planner.live_side(T2, {T1: "heating"}) == ("hold", True)
    # Off never holds or is held.
    await _mode(client, site, mode="off")
    assert planner.live_side(T1, {T2: "cooling"}) == ("off", True)


async def test_a_zone_with_no_side_joins_what_the_others_run(client, site):
    assert (await client.put(f"/api/zones/{T3}", json={"building_id": site})).status == 200
    await _mode(client, site, opposite_allowed=False)
    planner, _switched = await _plan(client, [_zone(T1), _zone(T2), _zone(T3)])
    assert planner.live_side(T3, {}) == (None, True)
    assert planner.live_side(T3, {T1: "heating"}) == ("heating", True)
    assert planner.live_side(T3, {T1: "heating", T2: "cooling"}) == ("hold", True)


async def test_a_zone_in_use_goes_first(client, site):
    await _mode(client, site, opposite_allowed=False)
    await _zone_mode(client, T1, "heat")
    await _zone_mode(client, T2, "cool")
    # T1 is in use and was held from heating last minute: T2, empty, waits.
    planner, _s = await _plan(
        client, [_zone(T1, in_use=True, held_for="heating"), _zone(T2, held_for="cooling")]
    )
    assert planner.claim(T2, "cooling") == "hold"
    assert planner.claim(T1, "heating") is None
    # A zone that is in use itself is not held back for another.
    planner, _s = await _plan(
        client,
        [_zone(T1, in_use=True, held_for="heating"), _zone(T2, in_use=True)],
    )
    assert planner.claim(T2, "cooling") is None


async def test_only_a_switch_that_is_about_to_happen_is_passed_on(client, site):
    scheduler = client.app["scheduler"]
    await _on_heating(client)
    just = {"since": NOW - timedelta(minutes=3)}
    planner, _s = await _plan(client, [_zone(T1, wants="cooling", **just)])
    assert planner.decisions()[T1].leaning == "cooling"
    scheduler._waiting_at_plan = {T1: "cooling"}
    # Zones may run opposite each other: nothing is passed on.
    assert scheduler._building_waiting(T2) is None
    await _mode(client, site, opposite_allowed=False)
    planner, _s = await _plan(client, [_zone(T1, wants="cooling", **just)])
    scheduler._waiting_at_plan = {T1: "cooling"}  # the replan above read the real engines
    assert scheduler._building_waiting(T2) == "cooling"
    assert scheduler._building_waiting(T1) is None  # its own wait
    # Held back by the limit, a wait can last a month: it is not passed on.
    await _mode(client, site, switching="monthly")
    _p, switched = await _plan(client, [_zone(T1, wants="cooling")], now=NOW)
    assert switched == [(T1, "cooling")]
    later = NOW + timedelta(days=3)
    planner, _s = await _plan(
        client, [_zone(T1, wants="heating", since=later - timedelta(minutes=3))], now=later
    )
    assert planner.decisions()[T1].leaning is None
    scheduler._waiting_at_plan = {T1: "heating"}
    assert scheduler._building_waiting(T2) is None


async def test_zones_on_different_sides_balance_the_way_they_run(client, site):
    scheduler = client.app["scheduler"]
    await _zone_mode(client, T1, "heat")
    await _zone_mode(client, T2, "cool")
    await _plan(client, [_zone(T1), _zone(T2)])
    assert scheduler.building_direction([T1, T2]) is None
    await _zone_mode(client, T2, "heat")
    await _plan(client, [_zone(T1), _zone(T2)])
    assert scheduler.building_direction([T1, T2]) == "heating"
    await _mode(client, site, mode="off")
    await _zone_mode(client, T1, "follow")
    await _zone_mode(client, T2, "follow")
    await _plan(client, [_zone(T1), _zone(T2)])
    assert scheduler.building_direction([T1, T2]) is None


async def test_an_upgrade_moves_one_side_per_building_to_each_zone(tmp_path):
    import aiosqlite

    conn = await aiosqlite.connect(tmp_path / "app.db")
    conn.row_factory = aiosqlite.Row
    try:
        await db.init_db(conn)
        await conn.execute("DELETE FROM system_settings WHERE key='migration_zone_modes_v1'")
        await conn.execute("INSERT INTO buildings(id, name) VALUES('b1', 'Main'), ('b2', 'Den')")
        for tid in (T1, T2, T3):
            await conn.execute(
                "INSERT INTO thermostat_configs(thermostat_entity_id, name) VALUES(?, ?)",
                (tid, tid),
            )
        await conn.execute(
            "INSERT INTO zone_profiles(thermostat_entity_id, building_id) VALUES(?, 'b1'),"
            " (?, 'b1'), (?, 'b2')",
            (T1, T2, T3),
        )
        await conn.execute(
            "INSERT INTO building_modes(building_id, mode, auto_level, side, switched_at,"
            " switch_day, switches) VALUES('b1', 'auto', 'on', 'heating', 1700000000,"
            " '2023-11-14', 1), ('b2', 'auto', 'watch', 'cooling', NULL, '', 0)"
        )
        await conn.execute("INSERT INTO zone_balance(building_id, level) VALUES('b1', 'watch')")
        await conn.execute(
            "INSERT INTO fireplaces(id, name, entity_id, control) VALUES('f', 'F', 'switch.f',"
            " 'watch')"
        )
        await conn.commit()
        await db._migrate_zone_modes(conn)
        await db._migrate_zone_modes(conn)  # runs once
        modes = await bm.load(conn)
        assert (modes["b1"].opposite_allowed, modes["b2"].opposite_allowed) == (False, True)
        sides = await bm.load_sides(conn)
        assert sorted(sides) == [T2, T1] or sorted(sides) == sorted([T1, T2])
        assert sides[T1].side == "heating" and sides[T1].switches == 1
        assert T3 not in sides
        async with conn.execute("SELECT level FROM zone_balance") as cur:
            assert [r[0] for r in await cur.fetchall()] == ["off"]
        async with conn.execute("SELECT control FROM fireplaces") as cur:
            assert [r[0] for r in await cur.fetchall()] == ["off"]
    finally:
        await conn.close()
