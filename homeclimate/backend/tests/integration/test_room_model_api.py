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
    assert by_id[bunk]["learned"] == {"loss": True, "pull": True, "heat": True, "cool": False}
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


async def test_a_failed_fit_never_escapes_the_job(client, rooms, monkeypatch, caplog):
    async def boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(rm, "fit_all", boom)
    assert await client.app["scheduler"].fit_room_models() == 0
    assert "Could not fit the room models" in caplog.text
    assert (await client.post("/api/learning/fit")).status == 200


async def test_the_fit_is_scheduled_for_the_small_hours(client):
    job = client.app["scheduler"]._apscheduler.get_job("room_model_fit")
    assert job is not None and "hour='3'" in str(job.trigger) and "minute='20'" in str(job.trigger)
