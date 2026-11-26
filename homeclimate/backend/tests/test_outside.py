"""The house's outside temperature: one sensor or the average of several."""

import pytest

from backend import outside


class _HA:
    def __init__(self, values):
        self.values = values

    def get_numeric_state(self, entity_id):
        value = self.values[entity_id]
        if isinstance(value, Exception):
            raise value
        return value


class TestParse:
    def test_a_single_id_reads_as_it_always_has(self):
        assert outside.parse("sensor.outdoor") == ["sensor.outdoor"]

    def test_blanks_spaces_and_repeats_are_dropped_in_order(self):
        assert outside.parse(" sensor.b, sensor.a ,,sensor.b ") == ["sensor.b", "sensor.a"]

    def test_nothing_stored_is_no_sensors(self):
        assert outside.parse("") == []
        assert outside.parse(None) == []


class TestAverage:
    def test_the_mean_of_the_sensors_that_answered(self):
        assert outside.average({"a": 60.0, "b": 70.0, "c": None}) == pytest.approx(65.0)

    def test_none_when_no_sensor_answered(self):
        assert outside.average({"a": None}) is None
        assert outside.average({}) is None


class TestReadings:
    def test_a_sensor_that_raises_reads_as_none(self):
        ha = _HA({"a": 61.0, "b": RuntimeError("gone")})
        assert outside.readings(ha, ["a", "b"]) == {"a": 61.0, "b": None}
