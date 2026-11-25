"""How each room warms and cools, fitted from its recorded readings.

Every night the last 30 days of a room's 5-minute readings are turned into
half-hour windows, and a small model is fitted to how fast the room's
temperature moved in each one:

    °F per hour =  loss  x (outside - room)        heat leaking through the walls
                 + pull  x (thermostat - room)     air mixing with the rest of the zone
                 + heat  x (share of the window heating, by how far the vent was open)
                 + cool  x (the same for cooling)
                 + sun   x (sun on the room's windows, 0 to about 1; ``backend/solar.py``)
                 + drift                            whatever is left (people, appliances)

A term with nothing to learn from keeps a sensible starting value and is
reported as not yet learned. Windows with an open door or window, a lit
fireplace, auxiliary heat, or a missing reading are left out.

The sun term is for rooms whose windows have a known direction (their shades,
in My Home) once the house's location is known. It is the clear-sky sun on
those windows; cloud and whether a shade was down are not recorded, so what is
learned is the room's usual gain on a day like those it has seen.

The model commands nothing. It is what later features (coasting, start
times, suggestions) read.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any

import aiosqlite

from . import db, learning, solar

FIT_DAYS = 30
WINDOW_STEPS = 6  # half an hour of 5-minute readings
STEP_S = learning.SAMPLE_EVERY_MIN * 60
WINDOW_H = WINDOW_STEPS * STEP_S / 3600

# Starting values: a house that loses 1 °F an hour for every 30 °F of
# difference, and equipment that moves a room about 3 °F an hour.
PRIOR = {"loss": 1 / 30, "pull": 0.1, "heat": 3.0, "cool": -3.0, "drift": 0.0, "sun": 0.0}
# How firmly each starting value is held until the data says otherwise.
PRIOR_WEIGHT = {
    "loss": 2000.0,
    "pull": 200.0,
    "heat": 2.0,
    "cool": 2.0,
    "drift": 20.0,
    "sun": 2.0,
}
TERMS = tuple(PRIOR)

MIN_WINDOWS = 48  # a day of usable half-hours before anything is fitted
READY_WINDOWS = 6 * 48  # six days of them before the room counts as ready
MODE_HOURS = 3.0  # hours of sustained heating (or cooling) before that rate is learned
SUN_HOURS = 10.0  # hours of sun on the windows before the sun term is learned
SUNLIT = 0.1  # a half-hour counts as sunlit when the sun on the windows averaged this much
SUSTAINED = 0.75  # a half-hour counts as sustained when the mode ran this much of it
LOSS_SPREAD_F = 3.0  # the outside-inside difference must have varied this much (std dev)
EARLY_START_MIN_MIN = 15  # a room is started at least this early, and
EARLY_START_MAX_MIN = 180  # at most this early
EARLY_START_STALE_DAYS = 7  # a model not refitted for this long is not trusted
MAX_RATE_F_PER_H = 12.0  # a faster change is a sensor glitch, not the room
MAX_STEP_F = MAX_RATE_F_PER_H * STEP_S / 3600 * 2  # between two readings five minutes apart

# What the thermostat says it is doing, as the model sees it. Anything not
# listed here (defrosting, drying, an action from a newer Home Assistant)
# moves heat in a way the model does not describe, so that half-hour is left out.
ACTIONS = {
    "heating": "heating",
    "preheating": "heating",
    "cooling": "cooling",
    "idle": "idle",
    "off": "idle",
    "fan": "idle",
}


@dataclass(frozen=True)
class Window:
    """Half an hour of one room: how fast it moved, and what was going on."""

    rate: float  # °F per hour
    out_diff: float  # outside minus room
    zone_diff: float  # thermostat minus room
    heat: float  # 0..1
    cool: float  # 0..1 (the fitted coefficient is negative)
    sun: float = 0.0  # sun on the room's windows, 0 to about 1


@dataclass(frozen=True)
class RoomModel:
    room_id: str
    fitted_at: datetime | None
    windows: int
    loss: float
    pull: float
    heat: float
    cool: float
    drift: float
    heat_hours: float  # hours of half-hours in which heating ran most of the time
    cool_hours: float
    out_spread: float  # standard deviation of outside minus room, °F
    rmse: float | None
    pinned: tuple[str, ...] = ()  # terms the fit got backwards, held at their starting value
    sun: float = 0.0  # °F per hour in full sun on the room's windows
    sun_hours: float = 0.0  # hours of half-hours with sun on the windows

    @property
    def learned(self) -> dict[str, bool]:
        """Which terms come from this room's own data rather than a starting value.

        The heating and cooling rates need sustained runs: a room held steady
        by short bursts says how loss and heating balance, but not how fast
        either is, so its rate is not trusted for timing a warm-up.
        """
        enough = self.windows >= MIN_WINDOWS

        def ok(term: str, test: bool) -> bool:
            return enough and test and term not in self.pinned

        return {
            "loss": ok("loss", self.out_spread >= LOSS_SPREAD_F),
            "heat": ok("heat", self.heat_hours >= MODE_HOURS),
            "cool": ok("cool", self.cool_hours >= MODE_HOURS),
            "sun": ok("sun", self.sun_hours >= SUN_HOURS),
        }

    @property
    def grade(self) -> str:
        """ "none" (too little to fit), "learning", or "ready".

        Ready means enough readings, heat loss learned, and at least one of
        the heating and cooling rates learned.
        """
        if self.windows < MIN_WINDOWS:
            return "none"
        learned = self.learned
        ready = (
            self.windows >= READY_WINDOWS
            and learned["loss"]
            and (learned["heat"] or learned["cool"])
        )
        return "ready" if ready else "learning"

    def rate(
        self,
        room: float,
        outside: float,
        zone: float | None = None,
        mode: str | None = None,
        sun: float = 0.0,
    ) -> float:
        """°F per hour the room would move at, with its vent open in ``mode``.

        ``sun`` is the sun on the room's windows (``solar.gain``); it counts
        only once the room's sun term has been learned.
        """
        value = self.loss * (outside - room) + self.drift
        if sun and self.learned["sun"]:
            value += self.sun * sun
        if zone is not None:
            value += self.pull * (zone - room)
        if mode == "heating":
            value += self.heat
        elif mode == "cooling":
            value += self.cool
        return value

    def minutes_to(
        self,
        start: float,
        target: float,
        outside: float,
        mode: str | None,
        limit_min: int = 360,
        zone: float | None = None,
    ) -> int | None:
        """Minutes for the room to go from ``start`` to ``target``; None if it won't in time.

        0 when it is already there: at or above the target when heating, at or
        below it when cooling, and for a room left alone, when the two are equal.
        Stepped five minutes at a time so the loss changes as the room moves.
        ``zone`` is the thermostat's reading, taken to stay where it is.
        """
        if mode == "heating":
            rising = True
        elif mode == "cooling":
            rising = False
        elif target == start:
            return 0
        else:
            rising = target > start
        if (start >= target) if rising else (start <= target):
            return 0
        temp = start
        for step in range(1, limit_min // learning.SAMPLE_EVERY_MIN + 1):
            temp += self.rate(temp, outside, zone, mode) * STEP_S / 3600
            if (temp >= target) if rising else (temp <= target):
                return step * learning.SAMPLE_EVERY_MIN
        return None


def windows_from(
    samples: list[learning.RoomSample], sun_at: Callable[[datetime], float] | None = None
) -> list[Window]:
    """Non-overlapping half-hour windows from one room's readings, oldest first.

    ``sun_at`` gives the sun on the room's windows at a time, for a room
    whose windows are known.
    """
    out: list[Window] = []
    i = 0
    while i + WINDOW_STEPS < len(samples):
        run = samples[i : i + WINDOW_STEPS + 1]
        first, last = run[0], run[-1]
        steady = all(
            (b.ts - a.ts).total_seconds() == STEP_S for a, b in zip(run, run[1:], strict=False)
        )
        usable = (
            steady
            and first.room_temp is not None
            and last.room_temp is not None
            and all(
                s.outside_temp is not None
                and not s.opening
                and not s.fireplace
                and not s.aux_heat
                and s.hvac_action in ACTIONS
                and s.thermostat_entity_id == first.thermostat_entity_id
                for s in run[:-1]
            )
            # A spike in the middle would skew the window's averages.
            and all(
                a.room_temp is None
                or b.room_temp is None
                or abs(b.room_temp - a.room_temp) <= MAX_STEP_F
                for a, b in zip(run, run[1:], strict=False)
            )
        )
        if not usable:
            i += 1
            continue
        assert first.room_temp is not None and last.room_temp is not None
        rate = (last.room_temp - first.room_temp) / WINDOW_H
        body = run[:-1]
        mid = [s.room_temp for s in body if s.room_temp is not None]
        room = sum(mid) / len(mid)
        outside = sum(s.outside_temp or 0.0 for s in body) / len(body)
        zones = [s.zone_temp for s in body if s.zone_temp is not None]
        zone_diff = (sum(zones) / len(zones) - room) if zones else 0.0

        def share(action: str, body: list[learning.RoomSample] = body) -> float:
            # A vent with no reported position is taken as open.
            return sum(
                (1.0 if s.vent_open is None else s.vent_open)
                for s in body
                if ACTIONS[s.hvac_action] == action
            ) / len(body)

        if abs(rate) <= MAX_RATE_F_PER_H:
            sun = 0.0 if sun_at is None else sum(sun_at(s.ts) for s in body) / len(body)
            out.append(
                Window(rate, outside - room, zone_diff, share("heating"), share("cooling"), sun)
            )
        i += WINDOW_STEPS
    return out


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Gaussian elimination with partial pivoting; the matrix is small and well-posed."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(m[r][col]))
        m[col], m[pivot] = m[pivot], m[col]
        for r in range(col + 1, n):
            factor = m[r][col] / m[col][col]
            for c in range(col, n + 1):
                m[r][c] -= factor * m[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (m[r][n] - sum(m[r][c] * x[c] for c in range(r + 1, n))) / m[r][r]
    return x


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / len(values))


def _least_squares(
    rows: list[tuple[float, ...]], rates: list[float], pinned: dict[str, float]
) -> dict[str, float]:
    """Fit the terms not pinned, each held toward its starting value; pinned ones stay put."""
    free = [i for i, term in enumerate(TERMS) if term not in pinned]
    # What the pinned terms already explain is taken out of what is left to fit.
    left = [
        rate - sum(pinned[TERMS[i]] * r[i] for i in range(len(TERMS)) if TERMS[i] in pinned)
        for r, rate in zip(rows, rates, strict=True)
    ]
    ata = [[sum(r[i] * r[j] for r in rows) for j in free] for i in free]
    atb = [sum(r[i] * y for r, y in zip(rows, left, strict=True)) for i in free]
    for k, i in enumerate(free):
        ata[k][k] += PRIOR_WEIGHT[TERMS[i]]
        atb[k] += PRIOR_WEIGHT[TERMS[i]] * PRIOR[TERMS[i]]
    solved = dict(zip((TERMS[i] for i in free), _solve(ata, atb), strict=True))
    return {**pinned, **solved}


def _backwards(beta: dict[str, float]) -> str | None:
    """A term whose sign defies physics: walls don't gain heat from the cold,
    heating doesn't cool, and a room isn't pushed away from the rest of its zone."""
    if beta["loss"] <= 0:
        return "loss"
    if beta["heat"] <= 0:
        return "heat"
    if beta["cool"] >= 0:
        return "cool"
    if beta["pull"] < 0:
        return "pull"
    if beta["sun"] < 0:
        return "sun"
    return None


def fit(room_id: str, windows: list[Window], *, now: datetime) -> RoomModel:
    """Least squares, with each term held toward its starting value until data outweighs it.

    A term that comes out backwards is held at its starting value (zero for
    the zone pull) and the rest are fitted again around it, so the model stays
    consistent with itself. Such a term is reported as not learned.
    """
    heat_hours = sum(WINDOW_H for w in windows if w.heat >= SUSTAINED)
    cool_hours = sum(WINDOW_H for w in windows if w.cool >= SUSTAINED)
    spread = _std([w.out_diff for w in windows])
    sun_hours = round(sum(WINDOW_H for w in windows if w.sun >= SUNLIT), 2)
    if len(windows) < MIN_WINDOWS:
        return RoomModel(
            room_id,
            None,
            len(windows),
            loss=PRIOR["loss"],
            pull=PRIOR["pull"],
            heat=PRIOR["heat"],
            cool=PRIOR["cool"],
            drift=PRIOR["drift"],
            heat_hours=round(heat_hours, 2),
            cool_hours=round(cool_hours, 2),
            out_spread=round(spread, 2),
            rmse=None,
            sun_hours=sun_hours,
        )
    rows: list[tuple[float, ...]] = [
        (w.out_diff, w.zone_diff, w.heat, w.cool, 1.0, w.sun) for w in windows
    ]
    rates = [w.rate for w in windows]
    pinned: dict[str, float] = {}
    beta = _least_squares(rows, rates, pinned)
    while (wrong := _backwards(beta)) is not None:
        pinned[wrong] = 0.0 if wrong in ("pull", "sun") else PRIOR[wrong]
        beta = _least_squares(rows, rates, pinned)
    sq = sum(
        (rate - sum(beta[term] * x for term, x in zip(TERMS, r, strict=True))) ** 2
        for r, rate in zip(rows, rates, strict=True)
    )
    return RoomModel(
        room_id=room_id,
        fitted_at=now,
        windows=len(windows),
        loss=round(beta["loss"], 5),
        pull=round(beta["pull"], 4),
        heat=round(beta["heat"], 3),
        cool=round(beta["cool"], 3),
        drift=round(beta["drift"], 3),
        heat_hours=round(heat_hours, 2),
        cool_hours=round(cool_hours, 2),
        out_spread=round(spread, 2),
        rmse=round(math.sqrt(sq / len(windows)), 3),
        pinned=tuple(pinned),
        sun=round(beta["sun"], 3),
        sun_hours=sun_hours,
    )


_fitting = asyncio.Lock()


async def fit_all(conn: aiosqlite.Connection, *, now: datetime) -> list[RoomModel]:
    """Fit every room from its last 30 days and store the result."""
    async with _fitting:
        since = now - timedelta(days=FIT_DAYS)
        models = []
        suns = await solar.for_rooms(conn)
        for room in await db.get_all_rooms(conn):
            samples = await learning.load(conn, room_id=room.id, since=since)
            models.append(fit(room.id, windows_from(samples, suns.get(room.id)), now=now))
        # Replaced row by row, so a failure part-way leaves the old rows alone.
        await conn.executemany(
            "INSERT OR REPLACE INTO room_models(room_id, fitted_at, windows, loss, pull, heat,"
            " cool, drift, heat_hours, cool_hours, out_spread, rmse, pinned, sun, sun_hours)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    m.room_id,
                    None if m.fitted_at is None else int(m.fitted_at.timestamp()),
                    m.windows,
                    m.loss,
                    m.pull,
                    m.heat,
                    m.cool,
                    m.drift,
                    m.heat_hours,
                    m.cool_hours,
                    m.out_spread,
                    m.rmse,
                    ",".join(m.pinned),
                    m.sun,
                    m.sun_hours,
                )
                for m in models
            ],
        )
        keep = [m.room_id for m in models]
        marks = ",".join("?" * len(keep))
        await conn.execute(f"DELETE FROM room_models WHERE room_id NOT IN ({marks})", keep)
        await conn.commit()
        return models


async def load(conn: aiosqlite.Connection) -> dict[str, RoomModel]:
    from datetime import UTC

    async with conn.execute("SELECT * FROM room_models") as cur:
        rows = await cur.fetchall()
    return {
        r["room_id"]: RoomModel(
            r["room_id"],
            None if r["fitted_at"] is None else datetime.fromtimestamp(r["fitted_at"], UTC),
            r["windows"],
            r["loss"],
            r["pull"],
            r["heat"],
            r["cool"],
            r["drift"],
            r["heat_hours"],
            r["cool_hours"],
            r["out_spread"],
            r["rmse"],
            tuple(t for t in r["pinned"].split(",") if t),
            r["sun"],
            r["sun_hours"],
        )
        for r in rows
    }


def describe(model: RoomModel) -> dict[str, Any]:
    """A model as the Smart Learning section shows it. Rates are °F deltas per hour."""
    data = asdict(model)
    data["fitted_at"] = None if model.fitted_at is None else model.fitted_at.isoformat()
    data["pinned"] = list(model.pinned)
    data["hours"] = round(model.windows * WINDOW_H, 1)
    data["learned"] = model.learned
    data["grade"] = model.grade
    return data
