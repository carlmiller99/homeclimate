"""
Integration tests for vacation mode API endpoints.

POST   /api/settings/vacation-mode  → enable
DELETE /api/settings/vacation-mode  → disable
GET    /api/settings/vacation-mode  → status
GET    /api/settings               → includes vacation_mode key
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from aiohttp.test_utils import TestClient

from backend import db
from backend.models import Room, ThermostatConfig

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

THERMO = "climate.upstairs"


async def _seed_thermo(client: TestClient) -> None:
    conn = client.app["scheduler"]._db_conn
    tc = ThermostatConfig(
        thermostat_entity_id=THERMO,
        name="Upstairs",
        min_setpoint=62.0,
        max_setpoint=80.0,
    )
    await db.upsert_thermostat_config(conn, tc)
    room = Room(id="r1", name="Living Room", thermostat_entity_id=THERMO)
    await db.upsert_room(conn, room)
    await client.app["scheduler"].refresh_engines()


# ---------------------------------------------------------------------------
# GET /api/settings includes vacation_mode
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_settings_includes_vacation_mode(client: TestClient):
    resp = await client.get("/api/settings")
    assert resp.status == 200
    data = await resp.json()
    assert "vacation_mode" in data
    assert data["vacation_mode"]["enabled"] is False
    assert data["vacation_mode"]["return_at"] is None


# ---------------------------------------------------------------------------
# GET /api/settings/vacation-mode
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_vacation_mode_default_off(client: TestClient):
    resp = await client.get("/api/settings/vacation-mode")
    assert resp.status == 200
    data = await resp.json()
    assert data["enabled"] is False
    assert data["return_at"] is None


# ---------------------------------------------------------------------------
# POST /api/settings/vacation-mode
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_enable_vacation_mode(client: TestClient):
    return_at = (datetime.now(UTC) + timedelta(days=7)).isoformat()
    resp = await client.post(
        "/api/settings/vacation-mode",
        json={"return_at": return_at},
    )
    assert resp.status == 200
    data = await resp.json()
    assert data["enabled"] is True
    assert data["return_at"] is not None

    # Confirm scheduler reflects it
    assert client.app["scheduler"].get_vacation_mode() is True


@pytest.mark.asyncio
async def test_enable_vacation_mode_missing_return_at(client: TestClient):
    resp = await client.post("/api/settings/vacation-mode", json={})
    assert resp.status == 400


@pytest.mark.asyncio
async def test_enable_vacation_mode_past_return_at(client: TestClient):
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    resp = await client.post("/api/settings/vacation-mode", json={"return_at": past})
    assert resp.status == 400


@pytest.mark.asyncio
async def test_enable_vacation_mode_invalid_return_at(client: TestClient):
    resp = await client.post("/api/settings/vacation-mode", json={"return_at": "not-a-date"})
    assert resp.status == 400


# ---------------------------------------------------------------------------
# DELETE /api/settings/vacation-mode
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_disable_vacation_mode(client: TestClient):
    # First enable it
    return_at = (datetime.now(UTC) + timedelta(days=7)).isoformat()
    await client.post("/api/settings/vacation-mode", json={"return_at": return_at})
    assert client.app["scheduler"].get_vacation_mode() is True

    # Then disable
    resp = await client.delete("/api/settings/vacation-mode")
    assert resp.status == 200
    data = await resp.json()
    assert data["enabled"] is False
    assert data["return_at"] is None
    assert client.app["scheduler"].get_vacation_mode() is False


# ---------------------------------------------------------------------------
# The range vacation hold is gone
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_client_that_still_sends_the_range_setting_changes_nothing(client: TestClient):
    """Older MCP clients and automations may still send ``vacation_hvac_mode``.

    There is one way to hold a house now, so the field is ignored rather than
    rejected: the rest of the write still lands and nothing comes back named
    after it.
    """
    await _seed_thermo(client)
    resp = await client.put(
        f"/api/thermostats/{THERMO}",
        json={"vacation_hvac_mode": "range", "name": "Up"},
    )
    assert resp.status == 200
    body = await resp.json()
    assert body["name"] == "Up"
    assert "vacation_hvac_mode" not in body


@pytest.mark.asyncio
async def test_the_range_test_endpoint_no_longer_exists(client: TestClient):
    await _seed_thermo(client)
    assert (await client.post(f"/api/thermostats/{THERMO}/test-vacation")).status in (404, 405)
    assert (await client.delete(f"/api/thermostats/{THERMO}/test-vacation")).status in (404, 405)
