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
    assert model.learned == {"loss": True, "heat": True, "cool": False, "sun": False}
    assert model.sun == 0.0 and model.sun_hours == 0.0  # no windows known: no sun term
    assert model.pinned == ()
    assert model.cool == rm.PRIOR["cool"]  # never cooled: the starting value stands

    summer = rm.fit("r1", rm.windows_from(_house(20, heat=False, cool=True)), now=NOW)
    assert summer.cool == pytest.approx(TRUE["cool"], rel=0.2)
    assert summer.learned["cool"] and not summer.learned["heat"]


def _noon_sun(ts: datetime) -> float:
    """A window that is sunlit from 09:00 to 15:00 UTC, brightest at noon."""
    hour = ts.hour + ts.minute / 60
    return max(0.0, math.cos((hour - 12) / 6 * math.pi)) if 9 <= hour <= 15 else 0.0


def test_the_sun_on_a_rooms_windows_is_learned():
    """A room that gains 2 °F an hour in full sun, on top of everything else."""
    samples = _house(20)
    shift = 0.0
    lit = []
    for i, sample in enumerate(samples):
        lit.append(
            learning.RoomSample(
                **{**sample.__dict__, "room_temp": round((sample.room_temp or 0) + shift, 2)}
            )
        )
        shift += 2.0 * _noon_sun(samples[i].ts) / 12
        # The room loses the extra warmth as it would any other.
        shift -= shift * (TRUE["loss"] + TRUE["pull"]) / 12
    model = rm.fit("r1", rm.windows_from(lit, _noon_sun), now=NOW)
    assert model.learned["sun"] and model.sun_hours > 50
    assert model.sun == pytest.approx(2.0, rel=0.3)
    # It moves a prediction only where the sun is, and only once learned.
    assert model.rate(70, 60, sun=1.0) - model.rate(70, 60) == pytest.approx(model.sun)
    assert model.rate(70, 60, sun=0.0) == model.rate(70, 60)
    # A room in sun warms sooner than the equipment's rate alone says (and
    # cools later), and the sun is read as the minutes go by.
    shade = model.minutes_to(62, 68, 30, "heating")
    full = model.minutes_to(62, 68, 30, "heating", sun_at=lambda minutes: 1.0)
    later = model.minutes_to(62, 68, 30, "heating", sun_at=lambda minutes: float(minutes >= 30))
    assert shade is not None and full is not None and later is not None
    assert full < later < shade
    # A term fitted from too few sunlit hours is not used.
    import dataclasses

    unsure = dataclasses.replace(model, sun_hours=rm.SUN_HOURS - 1)
    assert not unsure.learned["sun"] and unsure.rate(70, 60, sun=1.0) == unsure.rate(70, 60)
    # A half-hour is sunlit by its average: a brief flash does not count.
    flash = rm.windows_from(lit[:7], lambda ts: 0.5 if ts == lit[0].ts else 0.0)
    assert [round(w.sun, 4) for w in flash] == [round(0.5 / 6, 4)]
    assert rm.fit("r1", flash * 60, now=NOW).sun_hours == 0.0
    steady = rm.windows_from(lit[:7], lambda ts: rm.SUNLIT)
    assert rm.fit("r1", steady * 60, now=NOW).sun_hours == 30.0
    dark = rm.fit("r1", rm.windows_from(lit), now=NOW)
    assert not dark.learned["sun"] and dark.rate(70, 60, sun=1.0) == dark.rate(70, 60)
    assert rm.describe(model)["learned"]["sun"] is True
    # A sun term that comes out backwards is held at nothing.
    shaded = [
        learning.RoomSample(
            **{**s.__dict__, "room_temp": (s.room_temp or 0) - 1.5 * _noon_sun(s.ts)}
        )
        for s in samples
    ]
    backwards = rm.fit("r1", rm.windows_from(shaded, _noon_sun), now=NOW)
    assert "sun" in backwards.pinned and backwards.sun == 0.0 and not backwards.learned["sun"]
    # Too little to fit still reports the sunlit hours seen.
    few = rm.fit("r1", rm.windows_from(lit[:288], _noon_sun), now=NOW)
    assert few.fitted_at is None and 0 < few.sun_hours < 12


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
    samples[120] = changed(120, hvac_action="defrosting")
    samples[160] = changed(160, room_temp=None)
    samples[200] = changed(200, room_temp=samples[200].room_temp + 30)
    del samples[240]
    got = rm.windows_from(samples)
    assert clean - 9 <= len(got) < clean
    assert all(abs(w.rate) <= rm.MAX_RATE_F_PER_H for w in got)
    # No vent position reported counts as open; no thermostat reading as no pull.
    plain = [changed(i, vent_open=None, zone_temp=None) for i in range(len(samples))]
    assert all(w.zone_diff == 0.0 for w in rm.windows_from(plain))


def test_a_term_that_comes_out_backwards_is_held_and_the_rest_refitted_around_it():
    # A room that cooled a little whenever "heating" ran: a vent reported open but shut.
    rng = random.Random(3)
    windows = []
    for i in range(600):
        out_diff = -30.0 + 20.0 * rng.random()
        heat = 1.0 if i % 3 == 0 else 0.0
        rate = 0.04 * out_diff + 1.2 - 0.5 * heat + rng.gauss(0, 0.2)
        windows.append(rm.Window(rate, out_diff, 0.0, heat, 0.0))
    model = rm.fit("r1", windows, now=NOW)
    assert model.pinned == ("heat",) and model.heat == rm.PRIOR["heat"]
    assert model.learned["heat"] is False  # shown as not learned, not as a finding
    assert model.loss > 0 and model.cool < 0 and model.pull >= 0
    # The other terms were fitted again with the heat held, so the model is at least
    # as good as leaving them where the first fit put them.
    rows = [(w.out_diff, w.zone_diff, w.heat, w.cool, 1.0, w.sun) for w in windows]
    first = rm._least_squares(rows, [w.rate for w in windows], {})

    def error(beta):
        return sum(
            (w.rate - sum(beta[t] * x for t, x in zip(rm.TERMS, r, strict=True))) ** 2
            for r, w in zip(rows, windows, strict=True)
        )

    patched = {**first, "heat": rm.PRIOR["heat"]}
    final = {t: getattr(model, t) for t in rm.TERMS}
    assert error(final) < error(patched)
    assert rm.describe(model)["pinned"] == ["heat"]
    # Loss, cooling and pull coming out backwards are held the same way.
    odd = [
        rm.Window(rate=0.05 * d + 0.8 * c - 0.5 * z, out_diff=-d, zone_diff=z, heat=0.0, cool=c)
        for i, (d, c, z) in enumerate(
            [(10.0 + i % 20, float(i % 4 == 0), -2.0 + i % 5) for i in range(600)]
        )
    ]
    held = rm.fit("r1", odd, now=NOW)
    assert set(held.pinned) == {"loss", "cool", "pull"}
    assert held.loss == pytest.approx(rm.PRIOR["loss"], abs=1e-4)
    assert (held.cool, held.pull) == (rm.PRIOR["cool"], 0.0)
    assert not held.learned["loss"] and held.grade == "learning"


def test_a_room_held_steady_by_short_bursts_is_not_called_ready_for_timing():
    """Ten-minute burns at a constant setpoint, not lined up with the half-hours.

    They say how loss and heating balance but not how fast either is, so the
    heating rate must not be reported as learned however long it goes on.
    """
    rng = random.Random(7)
    start = NOW - timedelta(days=14)
    temp, burning, samples = 68.0, 0, []
    for minute in range(14 * 1440):
        hour = (minute % 1440) / 60
        outside = 35.0 + 10.0 * math.sin((hour - 9) / 24 * 2 * math.pi)
        if burning:
            burning -= 1
        elif temp < 67.6:
            burning = 10
        rate = 0.05 * (outside - temp) + 0.3 + (4.0 if burning else 0.0)
        temp += rate / 60
        if minute % 5 == 0:
            samples.append(
                learning.RoomSample(
                    ts=start + timedelta(minutes=minute),
                    room_id="r1",
                    thermostat_entity_id="climate.z",
                    room_temp=round(temp + rng.gauss(0, 0.05), 2),
                    zone_temp=None,
                    outside_temp=outside,
                    hvac_action="heating" if burning else "idle",
                    aux_heat=False,
                    vent_open=1.0,
                    zone_vent_open=1.0,
                    occupied=None,
                    opening=False,
                )
            )
    model = rm.fit("r1", rm.windows_from(samples), now=NOW)
    assert model.windows >= rm.READY_WINDOWS
    assert model.learned["heat"] is False
    assert model.grade == "learning"


def test_what_the_thermostat_says_it_is_doing():
    samples = _house(1)
    as_preheat = [
        learning.RoomSample(
            **{**s.__dict__, "hvac_action": "preheating" if s.hvac_action == "heating" else "off"}
        )
        for s in samples
    ]
    plain = rm.windows_from(samples)
    # Preheating is heating, and off is idle: the same windows come out.
    assert rm.windows_from(as_preheat) == plain
    # A thermostat that never says what it is doing gives the model nothing to use.
    silent = [learning.RoomSample(**{**s.__dict__, "hvac_action": "unknown"}) for s in samples]
    assert rm.windows_from(silent) == []
    # A room moved to another zone part-way through a half-hour: that one is left out.
    moved = list(samples)
    moved[3] = learning.RoomSample(**{**samples[3].__dict__, "thermostat_entity_id": "climate.b"})
    kept = rm.windows_from(moved)
    assert kept != plain and len(kept) <= len(plain)
    assert kept[0] != plain[0]  # the half-hour it fell in is not used as it was
    # A spike in the middle of a half-hour costs that half-hour.
    spiked = list(samples)
    spiked[9] = learning.RoomSample(
        **{**samples[9].__dict__, "room_temp": samples[9].room_temp + 30}
    )
    kept = rm.windows_from(spiked)
    assert kept != plain and all(abs(w.rate) <= rm.MAX_RATE_F_PER_H for w in kept)
    assert all(abs(w.out_diff - p.out_diff) < 4 for w, p in zip(kept[:3], plain[:3], strict=True))


def test_predictions_follow_the_model():
    model = rm.fit("r1", rm.windows_from(_house(20)), now=NOW)
    assert model.rate(68, 30) < 0 < model.rate(68, 30, mode="heating")
    assert model.rate(68, 30, zone=72) > model.rate(68, 30)
    assert model.rate(75, 95, mode="cooling") < model.rate(75, 95)
    warm_up = model.minutes_to(62, 68, 30, "heating")
    assert warm_up is not None and 60 <= warm_up <= 240
    assert model.minutes_to(62, 68, 30, "heating", limit_min=30) is None
    assert model.minutes_to(62, 68, 30, None) is None  # it will not warm on its own
    # Already there is no wait at all, not "never".
    assert model.minutes_to(68, 68, 30, "heating") == 0
    assert model.minutes_to(70, 68, 30, "heating") == 0
    assert model.minutes_to(68, 70, 95, "cooling") == 0
    assert model.minutes_to(68, 68, 30, None) == 0
    cool_down = model.minutes_to(78, 74, 95, "cooling")
    assert cool_down is not None and cool_down > 0
    # A warmer rest-of-the-zone shortens the warm-up.
    with_zone = model.minutes_to(62, 68, 30, "heating", zone=70)
    assert with_zone is not None and with_zone < warm_up
    coast = model.minutes_to(70, 66, 30, None)
    assert coast is not None and coast > 30
    assert rm.describe(model)["grade"] == "ready"
    assert rm.describe(model)["hours"] == model.windows / 2
    assert rm.describe(rm.fit("r1", [], now=NOW))["fitted_at"] is None


def test_a_jump_no_room_could_make_is_dropped():
    samples = _house(1)
    glitch = samples[6]
    samples[6] = learning.RoomSample(**{**glitch.__dict__, "room_temp": glitch.room_temp + 30})
    kept = rm.windows_from(samples)
    assert len(kept) < 48 - 1 and all(abs(w.rate) <= rm.MAX_RATE_F_PER_H for w in kept)
