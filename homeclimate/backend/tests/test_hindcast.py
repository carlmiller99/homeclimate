"""The model's one-hour-ahead guess, set against what a room actually did."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from backend import hindcast
from backend.learning import RoomSample
from backend.room_model import RoomModel

START = datetime(2026, 2, 2, 6, 0, tzinfo=UTC)
END = START + timedelta(hours=2)


def _model(**over):
    base = {
        "room_id": "den",
        "fitted_at": START,
        "windows": 400,
        "loss": 0.0,
        "pull": 0.0,
        "heat": 3.0,
        "cool": -3.0,
        "drift": 0.0,
        "heat_hours": 9.0,
        "cool_hours": 9.0,
        "out_spread": 6.0,
        "rmse": 0.3,
    }
    return RoomModel(**{**base, **over})


def _sample(i, temp, action="idle", **over):
    base = {
        "ts": hindcast.lookback(START) + timedelta(minutes=5 * i),
        "room_id": "den",
        "thermostat_entity_id": "climate.a",
        "room_temp": temp,
        "zone_temp": 70.0,
        "outside_temp": 40.0,
        "hvac_action": action,
        "aux_heat": False,
        "vent_open": 1.0,
        "zone_vent_open": 1.0,
        "occupied": None,
        "opening": None,
    }
    return RoomSample(**{**base, **over})


def test_each_point_is_predicted_from_the_reading_an_hour_before():
    # Heating the whole time at 3 °F an hour; the room really gains 2.4 °F an hour.
    samples = [_sample(i, 60.0 + 0.2 * i, "heating") for i in range(40)]
    out = hindcast.build(_model(), samples, start=START, end=END)
    assert out["start"] == START.isoformat() and out["end"] == END.isoformat()
    # One point every 15 minutes across the two hours.
    assert [p["at"] for p in out["points"]][:2] == [
        START.isoformat(),
        (START + timedelta(minutes=15)).isoformat(),
    ]
    assert len(out["points"]) == 8
    first = out["points"][0]
    # The reading an hour before 06:00 was 60.2 (index 1); an hour of heating adds 3.
    assert first == {"at": START.isoformat(), "measured": 62.6, "predicted": 63.2}
    assert out["typical_miss"] == 0.6 and out["predicted_points"] == 8


def test_the_vent_share_the_weather_the_zone_and_the_sun_all_count():
    model = _model(loss=0.1, pull=0.2, sun=1.0, sun_hours=20.0)
    samples = [_sample(i, 60.0, "cooling", vent_open=0.5) for i in range(14)]
    out = hindcast.build(model, samples, start=START, end=END, sun_at=lambda when: 0.5)
    (point,) = out["points"]
    # Stepped by hand: each five minutes moves the room by
    # (0.1*(40-t) + 0.2*(70-t) + 1.0*0.5 - 3*0.5) / 12.
    temp = 60.0
    for _ in range(12):
        temp += (0.1 * (40 - temp) + 0.2 * (70 - temp) + 0.5 - 1.5) / 12
    assert point["predicted"] == round(temp, 2)
    # A vent with no reported position is taken as open.
    unknown = [_sample(i, 60.0, "heating", vent_open=None) for i in range(14)]
    assert hindcast.build(_model(), unknown, start=START, end=END)["points"][0]["predicted"] == 63.0


def test_where_the_model_cannot_speak_only_the_measured_line_is_drawn():
    steady = [_sample(i, 65.0) for i in range(14)]
    for model in (None, _model(fitted_at=None)):
        out = hindcast.build(model, steady, start=START, end=END)
        assert out["points"] == [{"at": START.isoformat(), "measured": 65.0, "predicted": None}]
        assert out["typical_miss"] is None and out["predicted_points"] == 0
    # A door open, a fire, strip heat, a zone change, an unknown action, no
    # weather, a missing reading or a gap in the hour: no prediction.
    for change in (
        {"opening": True},
        {"fireplace": True},
        {"aux_heat": True},
        {"thermostat_entity_id": "climate.b"},
        {"hvac_action": "defrosting"},
        {"outside_temp": None},
        {"room_temp": None},
        {"ts": hindcast.lookback(START) + timedelta(minutes=26)},
    ):
        broken = list(steady)
        broken[5] = _sample(5, 65.0, **change)
        out = hindcast.build(_model(), broken, start=START, end=END)
        assert [p["predicted"] for p in out["points"]] == [None], change
    # Too little before the first point, readings off the quarter hour and
    # readings outside the day are left out.
    assert (
        hindcast.build(_model(), steady[10:], start=START, end=END)["points"][0]["predicted"]
        is None
    )
    assert hindcast.build(_model(), steady, start=END, end=END + timedelta(hours=1))["points"] == []
    missing = [*steady[:13], _sample(13, None)]
    assert hindcast.build(_model(), missing, start=START, end=END)["points"] == []
