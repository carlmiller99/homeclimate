"""The nightly fit, Fit Now, and models in the Smart Learning snapshot."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend import learning
from backend import room_model as rm
from backend.tests.test_room_model import _house

pytestmark = pytest.mark.asyncio

T1 = "climate.main"


@pytest.fixture
async def rooms(client, fake_ha):
    fake_ha.seed_state(T1, "heat", {"current_temperature": 70, "hvac_action": "idle"})
    ids = []
    for name in ("Bunk Room", "Craft Room"):
        resp = await client.post("/api/rooms", json={"name": name, "thermostat_entity_id": T1})
        ids.append((await resp.json())["id"])
    return ids


async def _record(client, room_id: str, days: float) -> None:
    """Store a simulated room's readings as if they ended just now."""
    conn = await client.app["scheduler"].get_db()
    samples = _house(days)
    shift = datetime.now(UTC).replace(second=0, microsecond=0) - samples[-1].ts
    shift -= timedelta(minutes=shift.seconds // 60 % 5)
    await learning.store(
        conn,
        [
            learning.RoomSample(
                **{**s.__dict__, "ts": s.ts + shift, "room_id": room_id, "thermostat_entity_id": T1}
            )
            for s in samples
        ],
    )


async def test_rooms_have_no_model_until_one_is_fitted(client, rooms):
    snap = await (await client.get("/api/learning")).json()
    assert [r["model"] for r in snap["rooms"]] == [None, None]


async def test_fit_now_fits_every_room_and_says_how_far_each_has_got(client, rooms):
    bunk, craft = rooms
    await _record(client, bunk, 10)
    snap = await (await client.post("/api/learning/fit")).json()
    by_id = {r["room_id"]: r["model"] for r in snap["rooms"]}
    assert by_id[bunk]["grade"] == "ready"
    assert by_id[bunk]["learned"] == {"loss": True, "heat": True, "cool": False, "sun": False}
    assert by_id[bunk]["pinned"] == []
    assert by_id[bunk]["heat"] == pytest.approx(4.0, rel=0.2)
    assert by_id[bunk]["fitted_at"] is not None and by_id[bunk]["hours"] > 200
    # A room with nothing recorded keeps the starting values and says so.
    assert by_id[craft]["grade"] == "none" and by_id[craft]["fitted_at"] is None
    assert by_id[craft]["heat"] == rm.PRIOR["heat"]
    events = await (await client.get("/api/logs/events?category=engine")).json()
    assert "Smart Learning fitted 1 of 2 rooms" in [e["message"] for e in events]
    # Fitting again replaces the rows rather than adding to them.
    await client.post("/api/learning/fit")
    conn = await client.app["scheduler"].get_db()
    assert set(await rm.load(conn)) == {bunk, craft}
    # A room that has been deleted drops out at the next fit.
    await client.delete(f"/api/rooms/{craft}")
    await client.post("/api/learning/fit")
    assert set(await rm.load(conn)) == {bunk}


async def test_only_the_last_thirty_days_are_used(client, rooms):
    bunk, _craft = rooms
    await _record(client, bunk, 40)
    conn = await client.app["scheduler"].get_db()
    await rm.fit_all(conn, now=datetime.now(UTC))
    model = (await rm.load(conn))[bunk]
    assert 29 * 48 <= model.windows <= 30 * 48


async def test_a_fit_needs_no_event_log_to_run(client, rooms, monkeypatch):
    bunk, _craft = rooms
    await _record(client, bunk, 10)
    scheduler = client.app["scheduler"]
    monkeypatch.setattr(scheduler, "_event_logger", None)
    assert await scheduler.fit_room_models_now() == 1


async def test_a_failed_fit_never_escapes_the_job(client, rooms, monkeypatch, caplog):
    async def boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(rm, "fit_all", boom)
    assert await client.app["scheduler"].fit_room_models() == 0
    assert "Could not fit the room models" in caplog.text
    # Asked for by hand, a failure is said, not passed off as done.
    resp = await client.post("/api/learning/fit")
    assert (resp.status, (await resp.json())["error"]) == (
        500,
        "Could not work out the room models",
    )


async def test_two_fits_at_once_do_not_collide(client, rooms):
    import asyncio

    conn = await client.app["scheduler"].get_db()
    now = datetime.now(UTC)
    await asyncio.gather(rm.fit_all(conn, now=now), rm.fit_all(conn, now=now))
    assert set(await rm.load(conn)) == set(rooms)


async def test_the_fit_is_scheduled_for_the_small_hours(client):
    job = client.app["scheduler"]._apscheduler.get_job("room_model_fit")
    assert job is not None and "hour='3'" in str(job.trigger) and "minute='20'" in str(job.trigger)


async def test_a_room_with_a_window_of_known_direction_is_fitted_with_the_sun(
    client, fake_ha, rooms
):
    from backend import solar

    bunk, craft = rooms
    await _record(client, bunk, 10)
    await _record(client, craft, 10)
    fake_ha.seed_state("cover.bunk_shade", "open", {})
    await client.put("/api/shades/cover.bunk_shade", json={"room_id": bunk, "facing": "S"})
    # Before the house's location is known there is no sun to speak of.
    snap = await (await client.post("/api/learning/fit")).json()
    by_id = {r["room_id"]: r["model"] for r in snap["rooms"]}
    assert by_id[bunk]["sun_hours"] == 0.0 and by_id[bunk]["sun"] == 0.0
    # Fit Now reads it from Home Assistant; then the windowed room has sunlit hours.
    fake_ha.seed_state("zone.home", "0", {"latitude": 32.0, "longitude": -95.0})
    snap = await (await client.post("/api/learning/fit")).json()
    conn = await client.app["scheduler"].get_db()
    assert await solar.location(conn) == (32.0, -95.0)
    by_id = {r["room_id"]: r["model"] for r in snap["rooms"]}
    assert by_id[bunk]["sun_hours"] > 20 and by_id[craft]["sun_hours"] == 0.0
    assert by_id[bunk]["sun"] >= 0.0 and set(by_id[bunk]["learned"]) >= {"sun"}
    # And it is read back as it was stored.
    stored = (await rm.load(conn))[bunk]
    assert (stored.sun, stored.sun_hours) == (by_id[bunk]["sun"], by_id[bunk]["sun_hours"])
