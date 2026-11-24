"""Shades: decisions, storage, the controller and the API."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta

import pytest

from backend import db, shades
from backend.shades import CLOSE, OPEN, Shade, Sun, decide


T1 = "climate.upstairs"
SHADE = "cover.bunk_shade"
NOON = time(12, 0)
T0 = datetime(2026, 1, 5, 18, 0, tzinfo=UTC)

ON = {name: spec[1] for name, spec in shades.SETTINGS.items()} | {"auto_enabled": True}
SOUTH = Shade(SHADE, "r1", "S")
SUN_S = Sun(elevation=30, azimuth=180, cloud_pct=10)


def _decide(shade=SOUTH, settings=ON, sun=SUN_S, mode="heating", **kw):
    args = {"occupied": False, "held": False, "local_time": NOON} | kw
    return decide(shade, settings, sun, mode, **args)


def test_decisions():
    assert _decide() == (OPEN, "Sunlit and heating, so opened.")
    assert _decide(mode="cooling") == (CLOSE, "Sunlit and cooling, so closed.")
    assert _decide(shade=Shade(SHADE, "r1", "N")) == (None, "Not sunlit, left alone.")
    assert _decide(sun=Sun(3, 180)) == (None, "Not sunlit, left alone.")
    assert _decide(sun=Sun(30, 180, 90)) == (None, "Overcast, left alone.")
    assert _decide(mode=None) == (None, "Zone is idle, left alone.")
    assert _decide(sun=Sun(None, None)) == (None, "Sun position unknown, left alone.")
    assert _decide(occupied=True) == (None, "Room occupied, left alone.")
    assert _decide(occupied=True, settings=ON | {"skip_occupied": False})[0] == OPEN
    assert _decide(held=True) == (None, "Moved by hand, so automation waits.")
    assert _decide(settings=ON | {"auto_enabled": False}) == (None, "Automation is off.")
    assert _decide(shade=Shade(SHADE, "r1", "S", never_control=True)) == (
        None,
        "Never controlled.",
    )


def test_night_and_quiet_hours():
    night = Sun(-10, 300)
    assert _decide(sun=night) == (None, "Overnight, left alone.")
    closing = ON | {"close_night_heat": True, "daylight_only": False}
    assert _decide(sun=night, settings=closing) == (
        CLOSE,
        "Night and heating, so closed to hold in heat.",
    )
    assert _decide(sun=night, settings=closing, mode="cooling")[0] is None
    # Daylight only wins over closing at night.
    assert _decide(sun=night, settings=ON | {"close_night_heat": True})[0] is None

    quiet = ON | {"quiet_hours": True}
    bedroom = Shade(SHADE, "r1", "S", quiet_hours=True)
    assert _decide(shade=bedroom, settings=quiet, local_time=time(21, 0)) == (
        None,
        "Quiet hours, left alone.",
    )
    assert _decide(shade=bedroom, settings=quiet, local_time=time(6, 59))[0] is None
    assert _decide(shade=bedroom, settings=quiet, local_time=time(7, 0))[0] == OPEN
    assert _decide(settings=quiet, local_time=time(21, 0))[0] == OPEN  # not a quiet shade
    assert shades.in_quiet_hours(time(13, 0), "12:00", "14:00")
    assert not shades.in_quiet_hours(time(15, 0), "12:00", "14:00")


def test_helpers():
    assert shades.angle_between(350, 10) == 20
    assert shades.angle_between(90, 270) == 180
    assert Sun.read(
        {"attributes": {"elevation": "12.5", "azimuth": 140}},
        {"attributes": {"cloud_coverage": "bad"}},
    ) == Sun(12.5, 140.0, None)
    assert Sun.read(None, None) == Sun(None, None, None)
    assert shades.is_open(None) is None
    assert shades.is_open({"state": "opening"}) is None
    assert shades.is_open({"state": "open"}) is True
    assert shades.is_open({"state": "open", "attributes": {"current_position": 0}}) is False
    assert shades.is_open({"state": "closed", "attributes": {"current_position": True}}) is False
    custom = Shade(SHADE, "r1", "S", open_position=60, closed_position=5)
    assert shades.is_open({"state": "open", "attributes": {"current_position": 5}}, custom) is False
    assert shades.is_open({"state": "open", "attributes": {"current_position": 55}}, custom) is True


# ---------------------------------------------------------------------------
# API and storage
# ---------------------------------------------------------------------------


@pytest.fixture
async def room(client, fake_ha):
    await client.post(
        "/api/thermostats",
        json={"thermostat_entity_id": T1, "name": "Upstairs", "total_vents_count": 4},
    )
    resp = await client.post("/api/rooms", json={"name": "Bunk Room", "thermostat_entity_id": T1})
    fake_ha.seed_state(SHADE, "closed", {"friendly_name": "Bunk Shade", "current_position": 0})
    fake_ha.seed_state("sun.sun", "above_horizon", {"elevation": 30, "azimuth": 180})
    fake_ha.seed_state(T1, "heat", {"current_temperature": 66})
    return str((await resp.json())["id"])


@pytest.mark.asyncio
async def test_settings_api(client):
    snap = await (await client.get("/api/shades")).json()
    assert snap["settings"]["auto_enabled"] is False
    assert snap["settings"]["quiet_start"] == "20:00"
    assert snap["sun"] == {"elevation": None, "azimuth": None, "cloud_pct": None}
    resp = await client.put(
        "/api/shades/settings",
        json={
            "auto_enabled": True,
            "manual_hold_min": 60,
            "quiet_start": "21:30",
            "weather_entity": "weather.home",
        },
    )
    settings = (await resp.json())["settings"]
    assert (settings["auto_enabled"], settings["manual_hold_min"]) == (True, 60)
    assert (settings["quiet_start"], settings["weather_entity"]) == ("21:30", "weather.home")
    cleared = await client.put("/api/shades/settings", json={"weather_entity": None})
    assert (await cleared.json())["settings"]["weather_entity"] == ""


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"auto_enabled": 1}, "auto_enabled must be true or false"),
        ({"min_move_min": 1}, "min_move_min must be a whole number of minutes from 5 to 240"),
        ({"manual_hold_min": True}, None),
        ({"quiet_end": "7:00"}, "quiet_end must be a time like 20:00"),
        ({"weather_entity": "sensor.x"}, "weather_entity must be a weather entity or empty"),
        ({"nope": 1}, "Unknown shade setting"),
    ],
)
@pytest.mark.asyncio
async def test_settings_validation(client, body, message):
    resp = await client.put("/api/shades/settings", json=body)
    assert resp.status == 400
    if message:
        assert (await resp.json())["error"] == message


@pytest.mark.asyncio
async def test_stored_garbage_falls_back(client):
    conn = await client.app["scheduler"].get_db()
    for name, raw in (("auto_enabled", "x"), ("min_move_min", "y"), ("manual_hold_min", "999")):
        await db.set_system_setting(conn, "shades_" + name, raw)
    await db.set_system_setting(conn, "shades_quiet_start", "late")
    settings = await shades.get_settings(conn)
    assert settings["auto_enabled"] is False
    assert (settings["min_move_min"], settings["manual_hold_min"]) == (30, 120)
    assert settings["quiet_start"] == "20:00"


@pytest.mark.asyncio
async def test_shade_crud(client, fake_ha, room):
    resp = await client.put(f"/api/shades/{SHADE}", json={"room_id": room, "facing": "S"})
    assert resp.status == 200
    [shade] = (await resp.json())["shades"]
    assert shade["name"] == "Bunk Shade"
    assert (shade["facing"], shade["state"], shade["reason"]) == ("S", "closed", "")
    resp = await client.put(
        f"/api/shades/{SHADE}",
        json={"facing": "SW", "quiet_hours": True, "open_position": 80, "closed_position": None},
    )
    [shade] = (await resp.json())["shades"]
    assert (shade["facing"], shade["quiet_hours"], shade["open_position"]) == ("SW", True, 80)
    assert shade["room_id"] == room

    fake_ha.seed_state(SHADE, "opening", {})
    [shade] = (await (await client.get("/api/shades")).json())["shades"]
    assert shade["state"] == "moving"
    await client.put("/api/shades/cover.unseen", json={"room_id": room, "facing": "N"})
    unseen = {s["entity_id"]: s for s in (await (await client.get("/api/shades")).json())["shades"]}
    assert unseen["cover.unseen"]["state"] == "unknown"

    vent_room = await client.post(f"/api/rooms/{room}/vents", json={"entity_id": "cover.bunk_vent"})
    assert vent_room.status in (200, 201)
    for path, body, message in [
        ("light.x", {"room_id": room, "facing": "S"}, "Choose a cover entity for the shade"),
        ("cover.bunk_vent", {"room_id": room, "facing": "S"}, "That cover is already a vent"),
        ("cover.new", {"room_id": "nope", "facing": "S"}, "That room does not exist"),
        ("cover.new", {"room_id": room, "facing": "Up"}, None),
        ("cover.new", {"room_id": room}, "Window Faces must be one of N, NE, E, SE, S, SW, W, NW"),
        ("cover.new", {"room_id": room, "facing": "S", "never_control": "y"}, None),
        ("cover.new", {"room_id": room, "facing": "S", "open_position": 101}, None),
        ("cover.new", {"room_id": room, "facing": "S", "closed_position": True}, None),
    ]:
        resp = await client.put(f"/api/shades/{path}", json=body)
        assert resp.status == 400, body
        if message:
            assert (await resp.json())["error"] == message

    assert (await client.delete(f"/api/shades/{SHADE}")).status == 200
    assert (await client.delete(f"/api/shades/{SHADE}")).status == 404


# ---------------------------------------------------------------------------
# Controller
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_controller_moves_holds_and_logs(client, fake_ha, room, tick):
    scheduler = client.app["scheduler"]
    conn = await scheduler.get_db()
    await client.put(f"/api/shades/{SHADE}", json={"room_id": room, "facing": "S"})
    await client.put("/api/shades/settings", json={"auto_enabled": True})
    ctl = shades.ShadeController()
    mode = scheduler.zone_mode

    # A shade that is moving is neither judged nor commanded.
    fake_ha.seed_state(SHADE, "opening", {})
    assert await ctl.run(conn, fake_ha, mode, T0 - timedelta(hours=1), NOON) == []
    fake_ha.seed_state(SHADE, "closed", {"current_position": 0})

    # Thermostat in heat, sun from the south: open it.
    moves = await ctl.run(conn, fake_ha, mode, T0, NOON)
    assert [(m.action, m.reason) for m in moves] == [(OPEN, "Sunlit and heating, so opened.")]
    assert fake_ha.calls_for("open_cover")
    fake_ha.seed_state(SHADE, "open", {"current_position": 100})

    # Our own move is not a manual move; cooling now wants it closed, but the
    # minimum time between moves has not passed.
    fake_ha.seed_state(T1, "cool", {})
    assert await ctl.run(conn, fake_ha, mode, T0 + timedelta(minutes=1), NOON) == []
    moves = await ctl.run(conn, fake_ha, mode, T0 + timedelta(minutes=31), NOON)
    assert [m.action for m in moves] == [CLOSE]
    fake_ha.seed_state(SHADE, "closed", {"current_position": 0})
    await ctl.run(conn, fake_ha, mode, T0 + timedelta(minutes=32), NOON)

    # Someone opens it by hand: automation waits for the hold.
    fake_ha.seed_state(SHADE, "open", {"current_position": 100})
    later = T0 + timedelta(minutes=80)
    assert await ctl.run(conn, fake_ha, mode, later, NOON) == []
    assert ctl.status[SHADE].reason == "Moved by hand, so automation waits."
    assert ctl.status[SHADE].hold_until == later + timedelta(minutes=120)
    moves = await ctl.run(conn, fake_ha, mode, later + timedelta(minutes=121), NOON)
    assert [m.action for m in moves] == [CLOSE]

    # Positions, when set, are used instead of open/close.
    fake_ha.seed_state(SHADE, "closed", {"current_position": 0})
    await client.put(f"/api/shades/{SHADE}", json={"open_position": 70, "closed_position": 5})
    fake_ha.seed_state(T1, "heat", {})
    fake_ha.reset_calls()
    await ctl.run(conn, fake_ha, mode, later + timedelta(minutes=200), NOON)
    assert fake_ha.calls_for("set_cover_position")
    fake_ha.seed_state(SHADE, "open", {"current_position": 70})
    fake_ha.seed_state(T1, "cool", {})
    await ctl.run(conn, fake_ha, mode, later + timedelta(minutes=300), NOON)
    assert len(fake_ha.calls_for("set_cover_position")) == 2

    # Occupied rooms are left alone; a removed shade is forgotten.
    presence = await client.post(
        f"/api/rooms/{room}/presence", json={"entity_id": "binary_sensor.bunk_occ"}
    )
    assert presence.status in (200, 201)
    fake_ha.seed_state("binary_sensor.bunk_occ", "on", {})
    fake_ha.seed_state(SHADE, "closed", {"current_position": 5})
    await ctl.run(conn, fake_ha, mode, later + timedelta(minutes=400), NOON)
    assert ctl.status[SHADE].reason == "Room occupied, left alone."
    await client.delete(f"/api/shades/{SHADE}")
    await ctl.run(conn, fake_ha, mode, later + timedelta(minutes=401), NOON)
    assert ctl.status == {}


@pytest.mark.asyncio
async def test_manual_moves_ignored_when_not_respected(client, fake_ha, room):
    conn = await client.app["scheduler"].get_db()
    await client.put(f"/api/shades/{SHADE}", json={"room_id": room, "facing": "N"})
    await client.put("/api/shades/settings", json={"auto_enabled": True, "respect_manual": False})
    ctl = shades.ShadeController()
    await ctl.run(conn, fake_ha, lambda _t: "heating", T0, NOON)
    fake_ha.seed_state(SHADE, "open", {"current_position": 100})
    await ctl.run(conn, fake_ha, lambda _t: "heating", T0 + timedelta(hours=1), NOON)
    assert ctl.status[SHADE].hold_until is None


@pytest.mark.asyncio
async def test_weather_entity_feeds_cloud_cover(client, fake_ha, room):
    conn = await client.app["scheduler"].get_db()
    await client.put(f"/api/shades/{SHADE}", json={"room_id": room, "facing": "S"})
    await client.put(
        "/api/shades/settings", json={"auto_enabled": True, "weather_entity": "weather.home"}
    )
    fake_ha.seed_state("weather.home", "cloudy", {"cloud_coverage": 95})
    ctl = shades.ShadeController()
    assert await ctl.run(conn, fake_ha, lambda _t: "heating", T0, NOON) == []
    assert ctl.status[SHADE].reason == "Overcast, left alone."
    snap = await (await client.get("/api/shades")).json()
    assert snap["sun"]["cloud_pct"] == 95
    assert snap["shades"][0]["reason"] == ""  # this controller is not the scheduler's


@pytest.mark.asyncio
async def test_scheduler_runs_shades_and_logs(client, fake_ha, room, tick, monkeypatch):
    scheduler = client.app["scheduler"]
    await client.put(f"/api/shades/{SHADE}", json={"room_id": room, "facing": "S"})
    await client.put("/api/shades/settings", json={"auto_enabled": True})
    await tick()
    events = await (await client.get("/api/logs/events?category=shades")).json()
    messages = [e["message"] for e in (events["events"] if isinstance(events, dict) else events)]
    assert messages == ["Bunk Shade: Sunlit and heating, so opened."]
    [shade] = (await (await client.get("/api/shades")).json())["shades"]
    assert shade["reason"] == "Sunlit and heating, so opened."
    assert shade["last_moved_at"] is not None

    assert scheduler.zone_mode("climate.unknown") is None
    scheduler._event_logger = None
    await scheduler._run_shades()

    async def boom(*_a, **_k):
        raise RuntimeError("no")

    monkeypatch.setattr(scheduler.shade_controller, "run", boom)
    await scheduler._run_shades()


@pytest.mark.asyncio
async def test_zone_mode_prefers_the_running_cycle(client, room):
    scheduler = client.app["scheduler"]
    await scheduler._sync_engines()
    engine = scheduler.get_engine(T1)
    assert engine is not None
    from backend.engine.cycle_engine import CycleState

    engine._state = CycleState.RUNNING
    engine._cycle_mode = "cooling"
    assert scheduler.zone_mode(T1) == "cooling"
    engine._state = CycleState.IDLE
    assert scheduler.zone_mode(T1) == "heating"
