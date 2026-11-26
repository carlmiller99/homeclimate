"""
Integration tests for Issue #85 Phase 1 HTTP endpoints:
  - GET/PUT /api/settings/outside-temp-entity (Phase 1b)
  - POST /api/metrics/rollup/daily          (Phase 1d manual trigger)
  - POST /api/metrics/rollup/monthly        (Phase 1e manual trigger)
"""

from __future__ import annotations

import pytest


class TestOutsideTempEntityEndpoint:
    @pytest.mark.asyncio
    async def test_get_returns_none_when_unset(self, client):
        resp = await client.get("/api/settings/outside-temp-entity")
        assert resp.status == 200
        body = await resp.json()
        assert body == {
            "entity_id": None,
            "entity_ids": [],
            "current_value": None,
            "values": {},
        }

    @pytest.mark.asyncio
    async def test_several_sensors_are_averaged(self, client, fake_ha):
        # 20 °C is 68 °F; with a 72 °F sensor the house reads 70 °F.
        fake_ha.seed_state("sensor.north_c", "20", {"unit_of_measurement": "°C"})
        fake_ha.seed_state("sensor.south_f", "72", {"unit_of_measurement": "°F"})
        resp = await client.put(
            "/api/settings/outside-temp-entity",
            json={"entity_ids": ["sensor.north_c", " sensor.south_f ", "sensor.north_c"]},
        )
        assert resp.status == 200
        body = await resp.json()
        assert body["entity_ids"] == ["sensor.north_c", "sensor.south_f"]
        assert body["entity_id"] == "sensor.north_c"
        assert body["current_value"] == pytest.approx(70.0)
        assert body["values"] == {
            "sensor.north_c": pytest.approx(68.0),
            "sensor.south_f": pytest.approx(72.0),
        }
        again = await (await client.get("/api/settings/outside-temp-entity")).json()
        assert again == body

    @pytest.mark.asyncio
    async def test_a_sensor_that_stops_answering_is_left_out(self, client, fake_ha):
        fake_ha.seed_state("sensor.a", "60", {"unit_of_measurement": "°F"})
        fake_ha.seed_state("sensor.b", "70", {"unit_of_measurement": "°F"})
        resp = await client.put(
            "/api/settings/outside-temp-entity", json={"entity_ids": ["sensor.a", "sensor.b"]}
        )
        assert resp.status == 200
        fake_ha.seed_state("sensor.b", "unavailable", {})
        body = await (await client.get("/api/settings/outside-temp-entity")).json()
        assert body["current_value"] == pytest.approx(60.0)
        assert body["values"] == {"sensor.a": pytest.approx(60.0), "sensor.b": None}

    @pytest.mark.asyncio
    async def test_put_rejects_one_bad_sensor_and_stores_none_of_them(self, client, fake_ha):
        fake_ha.seed_state("sensor.a", "60", {"unit_of_measurement": "°F"})
        fake_ha.seed_state("sensor.words", "sunny", {})
        for bad in ("sensor.missing", "sensor.words"):
            resp = await client.put(
                "/api/settings/outside-temp-entity", json={"entity_ids": ["sensor.a", bad]}
            )
            assert resp.status == 400
            assert bad in (await resp.json())["error"]
        body = await (await client.get("/api/settings/outside-temp-entity")).json()
        assert body["entity_ids"] == []

    @pytest.mark.asyncio
    async def test_put_rejects_a_malformed_list_or_too_many(self, client, fake_ha):
        for bad in ("sensor.a", ["sensor.a", 3], None):
            resp = await client.put("/api/settings/outside-temp-entity", json={"entity_ids": bad})
            assert resp.status == 400
        resp = await client.put("/api/settings/outside-temp-entity", json=["sensor.a"])
        assert resp.status == 400
        many = [f"sensor.s{i}" for i in range(9)]
        for entity_id in many:
            fake_ha.seed_state(entity_id, "60", {"unit_of_measurement": "°F"})
        resp = await client.put("/api/settings/outside-temp-entity", json={"entity_ids": many})
        assert resp.status == 400
        assert "at most 8" in (await resp.json())["error"]

    @pytest.mark.asyncio
    async def test_the_engine_and_recorder_read_the_same_average(self, client, fake_ha):
        from backend import db, outside

        conn = await client.app["scheduler"].get_db()
        await outside.store(conn, ["sensor.a", " sensor.b", "sensor.a"])
        assert await db.get_system_setting(conn, outside.SETTING, "") == "sensor.a,sensor.b"
        assert await outside.read(conn, fake_ha) is None
        fake_ha.seed_state("sensor.a", "50", {"unit_of_measurement": "°F"})
        fake_ha.seed_state("sensor.b", "54", {"unit_of_measurement": "°F"})
        assert await outside.read(conn, fake_ha) == pytest.approx(52.0)

    @pytest.mark.asyncio
    async def test_an_empty_list_clears_the_setting(self, client, fake_ha):
        fake_ha.seed_state("sensor.a", "60", {"unit_of_measurement": "°F"})
        await client.put("/api/settings/outside-temp-entity", json={"entity_ids": ["sensor.a"]})
        resp = await client.put("/api/settings/outside-temp-entity", json={"entity_ids": []})
        assert resp.status == 200
        assert (await resp.json())["entity_ids"] == []

    @pytest.mark.asyncio
    async def test_put_rejects_unknown_entity(self, client):
        resp = await client.put(
            "/api/settings/outside-temp-entity",
            json={"entity_id": "sensor.nonexistent"},
        )
        assert resp.status == 400

    @pytest.mark.asyncio
    async def test_put_rejects_non_numeric_entity(self, client, fake_ha):
        fake_ha.seed_state("sensor.weather_state", "sunny", {})
        resp = await client.put(
            "/api/settings/outside-temp-entity",
            json={"entity_id": "sensor.weather_state"},
        )
        assert resp.status == 400

    @pytest.mark.asyncio
    async def test_put_accepts_celsius_entity_and_returns_fahrenheit(self, client, fake_ha):
        # HAClient.get_numeric_state normalises °C → °F: 20°C → 68°F.
        fake_ha.seed_state("sensor.outdoor_c", "20", {"unit_of_measurement": "°C"})
        resp = await client.put(
            "/api/settings/outside-temp-entity",
            json={"entity_id": "sensor.outdoor_c"},
        )
        assert resp.status == 200
        body = await resp.json()
        assert body["entity_id"] == "sensor.outdoor_c"
        assert body["current_value"] == pytest.approx(68.0)

        body2 = await (await client.get("/api/settings/outside-temp-entity")).json()
        assert body2["entity_id"] == "sensor.outdoor_c"
        assert body2["current_value"] == pytest.approx(68.0)

    @pytest.mark.asyncio
    async def test_put_clears_with_null(self, client, fake_ha):
        fake_ha.seed_state("sensor.outdoor_f", "55", {"unit_of_measurement": "°F"})
        await client.put(
            "/api/settings/outside-temp-entity",
            json={"entity_id": "sensor.outdoor_f"},
        )
        resp = await client.put(
            "/api/settings/outside-temp-entity",
            json={"entity_id": None},
        )
        assert resp.status == 200
        assert (await resp.json()) == {
            "entity_id": None,
            "entity_ids": [],
            "current_value": None,
            "values": {},
        }

    @pytest.mark.asyncio
    async def test_put_clears_with_empty_string(self, client, fake_ha):
        fake_ha.seed_state("sensor.outdoor_f", "55", {"unit_of_measurement": "°F"})
        await client.put(
            "/api/settings/outside-temp-entity",
            json={"entity_id": "sensor.outdoor_f"},
        )
        resp = await client.put(
            "/api/settings/outside-temp-entity",
            json={"entity_id": ""},
        )
        assert resp.status == 200
        assert (await resp.json()) == {
            "entity_id": None,
            "entity_ids": [],
            "current_value": None,
            "values": {},
        }

    @pytest.mark.asyncio
    async def test_put_requires_entity_id_field(self, client):
        resp = await client.put("/api/settings/outside-temp-entity", json={})
        assert resp.status == 400


class TestHaEntitiesMultiDomain:
    """Issue #85 Phase 3c — `/api/ha/entities?domain=sensor,weather` so the
    outside-temp picker can fetch both domains in one round-trip."""

    @pytest.mark.asyncio
    async def test_comma_separated_domains(self, client, fake_ha):
        fake_ha.seed_state("sensor.outdoor_temp", "65", {"unit_of_measurement": "°F"})
        fake_ha.seed_state("weather.home", "sunny", {"temperature": 68, "temperature_unit": "°F"})
        fake_ha.seed_state("climate.thermo_a", "cool", {})

        resp = await client.get("/api/ha/entities?domain=sensor,weather")
        assert resp.status == 200
        body = await resp.json()
        ids = {e["entity_id"] for e in body}
        assert "sensor.outdoor_temp" in ids
        assert "weather.home" in ids
        assert "climate.thermo_a" not in ids

    @pytest.mark.asyncio
    async def test_single_domain_unchanged(self, client, fake_ha):
        fake_ha.seed_state("sensor.outdoor_temp", "65", {"unit_of_measurement": "°F"})
        fake_ha.seed_state("weather.home", "sunny", {})
        resp = await client.get("/api/ha/entities?domain=sensor")
        body = await resp.json()
        ids = {e["entity_id"] for e in body}
        assert "sensor.outdoor_temp" in ids
        assert "weather.home" not in ids


class TestRollupTriggerEndpoints:
    @pytest.mark.asyncio
    async def test_daily_trigger_succeeds_with_no_cycles(self, client):
        resp = await client.post("/api/metrics/rollup/daily", json={"days_back": 0})
        assert resp.status == 200
        body = await resp.json()
        assert body["rows_written"] == 0
        assert body["days_back"] == 0

    @pytest.mark.asyncio
    async def test_daily_trigger_works_without_body(self, client):
        resp = await client.post("/api/metrics/rollup/daily")
        assert resp.status == 200
        body = await resp.json()
        # default days_back=1
        assert body["days_back"] == 1
        assert body["rows_written"] == 0

    @pytest.mark.asyncio
    async def test_monthly_trigger_succeeds_with_no_cycles(self, client):
        resp = await client.post("/api/metrics/rollup/monthly", json={"months_back": 0})
        assert resp.status == 200
        body = await resp.json()
        assert body["rows_written"] == 0
        assert body["months_back"] == 0


class TestRoomDevicePickers:
    """`/api/ha/entities?kind=…&room=…` behind My Home's room device boxes."""

    def _seed(self, fake_ha):
        temp = {"device_class": "temperature", "unit_of_measurement": "°F"}
        fake_ha.seed_state("sensor.den_temp", "70", {**temp, "friendly_name": "Den Temp"})
        fake_ha.seed_state("sensor.attic_temp", "90", temp)
        fake_ha.seed_state("sensor.den_humidity", "40", {"device_class": "humidity"})
        fake_ha.seed_state("sensor.den_battery", "88", {"device_class": "battery"})
        fake_ha.seed_state("binary_sensor.den_motion", "off", {"device_class": "motion"})
        fake_ha.seed_state("binary_sensor.den_door", "off", {"device_class": "door"})
        fake_ha.seed_state("binary_sensor.den_leak", "off", {"device_class": "moisture"})
        fake_ha.seed_state("cover.den_register", "open", {})
        fake_ha.seed_state("cover.den_blind", "open", {"device_class": "blind"})
        # Never offered as a vent: the engine would open and close it.
        fake_ha.seed_state("cover.garage_door", "closed", {"device_class": "garage"})
        fake_ha.seed_state("cover.side_gate", "closed", {"device_class": "gate"})
        # Measured in degrees but with no device class (a template sensor, say).
        fake_ha.seed_state("sensor.den_probe", "69", {"unit_of_measurement": "°C"})
        # The class without a unit is not a usable reading.
        fake_ha.seed_state("sensor.den_unitless", "69", {"device_class": "temperature"})
        fake_ha.registries["areas"] = [
            {"area_id": "den", "name": "The  DEN"},
            {"area_id": "attic", "name": "Attic"},
        ]
        fake_ha.registries["devices"] = [{"id": "dev1", "area_id": "den"}]
        fake_ha.registries["entities"] = [
            {"entity_id": "sensor.den_temp", "device_id": "dev1"},
            {"entity_id": "sensor.attic_temp", "area_id": "attic"},
            {"entity_id": "binary_sensor.den_motion", "area_id": "den"},
        ]

    @pytest.mark.asyncio
    async def test_each_kind_lists_only_its_own_entities(self, client, fake_ha):
        self._seed(fake_ha)
        wanted = {
            "temperature": ["sensor.attic_temp", "sensor.den_probe", "sensor.den_temp"],
            "presence": ["binary_sensor.den_motion"],
            "contacts": ["binary_sensor.den_door"],
            # Any cover that is not a shade can be a vent, whatever it is called.
            "vents": ["cover.den_register"],
        }
        for kind, expected in wanted.items():
            domain = {"temperature": "sensor", "vents": "cover"}.get(kind, "binary_sensor")
            resp = await client.get("/api/ha/entities", params={"domain": domain, "kind": kind})
            assert resp.status == 200
            assert [e["entity_id"] for e in await resp.json()] == expected, kind
        bad = await client.get("/api/ha/entities", params={"domain": "sensor", "kind": "lights"})
        assert bad.status == 400

    @pytest.mark.asyncio
    async def test_entities_in_the_rooms_area_come_first(self, client, fake_ha):
        self._seed(fake_ha)
        resp = await client.get(
            "/api/ha/entities",
            params={"domain": "sensor", "kind": "temperature", "room": "the den"},
        )
        body = await resp.json()
        # The den's sensor leads although "attic" sorts before it.
        assert [(e["entity_id"], e["area_name"], e["in_room_area"]) for e in body] == [
            ("sensor.den_temp", "The  DEN", True),
            ("sensor.attic_temp", "Attic", False),
            ("sensor.den_probe", None, False),
        ]
        # A room with no area of that name changes nothing but still names areas.
        other = await (
            await client.get(
                "/api/ha/entities",
                params={"domain": "sensor", "kind": "temperature", "room": "Loft"},
            )
        ).json()
        assert [(e["entity_id"], e["in_room_area"]) for e in other] == [
            ("sensor.attic_temp", False),
            ("sensor.den_probe", False),
            ("sensor.den_temp", False),
        ]
        # Without a room nothing is looked up.
        plain = await (await client.get("/api/ha/entities?domain=sensor&kind=temperature")).json()
        assert all(e["area_name"] is None and e["in_room_area"] is False for e in plain)

    @pytest.mark.asyncio
    async def test_the_list_survives_registries_that_cannot_be_read(self, client, fake_ha):
        self._seed(fake_ha)

        async def _boom():
            raise RuntimeError("registry secret internals")

        fake_ha.get_registries = _boom
        resp = await client.get(
            "/api/ha/entities", params={"domain": "sensor", "kind": "temperature", "room": "Den"}
        )
        assert resp.status == 200
        assert "secret internals" not in await resp.text()
        assert [e["entity_id"] for e in await resp.json()] == [
            "sensor.attic_temp",
            "sensor.den_probe",
            "sensor.den_temp",
        ]
