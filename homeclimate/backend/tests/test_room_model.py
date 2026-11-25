"""The per-room model: recovering known values from a simulated house."""

from __future__ import annotations

import math
import random
from datetime import UTC, datetime, timedelta

import pytest

from backend import learning
from backend import room_model as rm

NOW = datetime(2026, 1, 20, 3, 20, tzinfo=UTC)
TRUE = {"loss": 0.05, "pull": 0.2, "heat": 4.0, "cool": -2.5, "drift": 0.3}


def _house(days: float, *, seed=1, noise=0.05, heat=True, cool=False, vent=1.0, **odd):
    """Readings from a room that obeys TRUE exactly, plus sensor noise."""
    rng = random.Random(seed)
    start = NOW - timedelta(days=days)
    temp = 68.0
    out: list[learning.RoomSample] = []
    for i in range(int(days * 288)):
        ts = start + timedelta(minutes=5 * i)
        hour = (i % 288) / 12
        outside = 45.0 + 15.0 * math.sin((hour - 9) / 24 * 2 * math.pi) + (45 if cool else 0)
        zone = 69.0 + 2.0 * math.sin(hour / 24 * 2 * math.pi) + (5 if cool else 0)
        action = "idle"
        if heat and temp < 67.0:
            action = "heating"
        if cool and temp > 75.0:
            action = "cooling"
        # Stay in a mode for whole half hours, as real cycles do.
        if out and out[-1].hvac_action != "idle" and i % 6:
            action = out[-1].hvac_action
        out.append(
            learning.RoomSample(
                ts=ts,
                room_id="r1",
                thermostat_entity_id="climate.z",
                room_temp=round(temp + rng.gauss(0, noise), 2),
                zone_temp=zone,
                outside_temp=outside,
                hvac_action=action,
                aux_heat=False,
                vent_open=vent,
                zone_vent_open=1.0,
                occupied=None,
                opening=False,
                **odd,
            )
        )
        rate = TRUE["loss"] * (outside - temp) + TRUE["pull"] * (zone - temp) + TRUE["drift"]
        if action == "heating":
            rate += TRUE["heat"] * vent
        if action == "cooling":
            rate += TRUE["cool"] * vent
        temp += rate / 12
    return out


def test_it_recovers_what_a_simulated_room_is_really_like():
    model = rm.fit("r1", rm.windows_from(_house(20)), now=NOW)
    assert model.grade == "ready"
    assert model.loss == pytest.approx(TRUE["loss"], rel=0.2)
    assert model.pull == pytest.approx(TRUE["pull"], rel=0.25)
    assert model.heat == pytest.approx(TRUE["heat"], rel=0.15)
    assert model.rmse is not None and model.rmse < 0.5
    assert model.learned == {"loss": True, "pull": True, "heat": True, "cool": False}
    assert model.cool == rm.PRIOR["cool"]  # never cooled: the starting value stands

    summer = rm.fit("r1", rm.windows_from(_house(20, heat=False, cool=True)), now=NOW)
    assert summer.cool == pytest.approx(TRUE["cool"], rel=0.2)
    assert summer.learned["cool"] and not summer.learned["heat"]


def test_a_half_open_vent_delivers_half_and_the_full_rate_is_still_found():
    model = rm.fit("r1", rm.windows_from(_house(20, vent=0.5)), now=NOW)
    assert model.heat == pytest.approx(TRUE["heat"], rel=0.2)


def test_too_little_to_go_on_keeps_the_starting_values():
    model = rm.fit("r1", rm.windows_from(_house(0.5)), now=NOW)
    assert (model.grade, model.fitted_at, model.rmse) == ("none", None, None)
    assert {t: getattr(model, t) for t in rm.TERMS} == rm.PRIOR
    assert not any(model.learned.values())
    assert rm.fit("r1", [], now=NOW).windows == 0
    # A few days is a fit, but not yet one to rely on.
    assert rm.fit("r1", rm.windows_from(_house(3)), now=NOW).grade == "learning"


def test_windows_leave_out_what_would_mislead():
    clean = len(rm.windows_from(_house(2)))
    assert clean == 2 * 48 - 1
    for odd in ({"fireplace": True},):
        assert rm.windows_from(_house(2, **odd)) == []
    samples = _house(2)

    def changed(i, **over):
        s = samples[i]
        return learning.RoomSample(**{**s.__dict__, **over})

    # One open window, one stretch of auxiliary heat, one missing reading, one gap,
    # one unknown action and one impossible jump each cost the window they fall in.
    samples[3] = changed(3, opening=True)
    samples[40] = changed(40, aux_heat=True)
    samples[80] = changed(80, outside_temp=None)
    samples[120] = changed(120, hvac_action="unknown")
    samples[160] = changed(160, room_temp=None)
    samples[200] = changed(200, room_temp=samples[200].room_temp + 30)
    del samples[240]
    got = rm.windows_from(samples)
    assert clean - 9 <= len(got) < clean
    assert all(abs(w.rate) <= rm.MAX_RATE_F_PER_H for w in got)
    # No vent position reported counts as open; no thermostat reading as no pull.
    plain = [changed(i, vent_open=None, zone_temp=None) for i in range(len(samples))]
    assert all(w.zone_diff == 0.0 for w in rm.windows_from(plain))


def test_a_fit_that_defies_physics_keeps_the_starting_value():
    # A room that got colder whenever the heat ran and warmer when it was cold out.
    windows = [
        rm.Window(
            rate=-2.0 if i % 2 else 2.0,
            out_diff=-30.0 if i % 2 == 0 else -5.0,
            zone_diff=-1.0 if i % 2 == 0 else 1.0,
            heat=float(i % 2),
            cool=float(i % 2 == 0),
        )
        for i in range(400)
    ]
    model = rm.fit("r1", windows, now=NOW)
    assert model.loss == rm.PRIOR["loss"] or model.loss > 0
    assert model.heat > 0 and model.cool < 0 and model.pull >= 0


def test_predictions_follow_the_model():
    model = rm.fit("r1", rm.windows_from(_house(20)), now=NOW)
    assert model.rate(68, 30) < 0 < model.rate(68, 30, mode="heating")
    assert model.rate(68, 30, zone=72) > model.rate(68, 30)
    assert model.rate(75, 95, mode="cooling") < model.rate(75, 95)
    warm_up = model.minutes_to(62, 68, 30, "heating")
    assert warm_up is not None and 60 <= warm_up <= 240
    assert model.minutes_to(62, 68, 30, "heating", limit_min=30) is None
    assert model.minutes_to(62, 68, 30, None) is None  # it will not warm on its own
    coast = model.minutes_to(70, 66, 30, None)
    assert coast is not None and coast > 30
    assert rm.describe(model)["grade"] == "ready"
    assert rm.describe(model)["hours"] == model.windows / 2
    assert rm.describe(rm.fit("r1", [], now=NOW))["fitted_at"] is None


def test_a_jump_no_room_could_make_is_dropped_and_a_backwards_pull_is_zero():
    samples = _house(1)
    glitch = samples[6]
    samples[6] = learning.RoomSample(**{**glitch.__dict__, "room_temp": glitch.room_temp + 30})
    windows = rm.windows_from(samples)
    assert len(windows) == 48 - 1 - 2  # the windows ending and starting on the glitch
    # A room that moved away from the rest of its zone: no pull, rather than a negative one.
    odd = [
        rm.Window(rate=-0.5 * z, out_diff=-20.0 + (i % 7), zone_diff=z, heat=0.0, cool=0.0)
        for i, z in enumerate([-2.0, -1.0, 1.0, 2.0] * 100)
    ]
    assert rm.fit("r1", odd, now=NOW).pull == 0.0
