"""How each room warms and cools, fitted from its recorded readings.

Every night the last 30 days of a room's 5-minute readings are turned into
half-hour windows, and a small model is fitted to how fast the room's
temperature moved in each one:

    °F per hour =  loss  x (outside - room)        heat leaking through the walls
                 + pull  x (thermostat - room)     air mixing with the rest of the zone
                 + heat  x (share of the window heating, by how far the vent was open)
                 + cool  x (the same for cooling)
                 + drift                            whatever is left (people, appliances)

A term with nothing to learn from keeps a sensible starting value and is
reported as not yet learned. Windows with an open door or window, a lit
fireplace, auxiliary heat, or a missing reading are left out.

The model commands nothing. It is what later features (coasting, start
times, suggestions) read.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any

import aiosqlite

from . import db, learning

FIT_DAYS = 30
WINDOW_STEPS = 6  # half an hour of 5-minute readings
STEP_S = learning.SAMPLE_EVERY_MIN * 60
WINDOW_H = WINDOW_STEPS * STEP_S / 3600

# Starting values: a house that loses 1 °F an hour for every 30 °F of
# difference, and equipment that moves a room about 3 °F an hour.
PRIOR = {"loss": 1 / 30, "pull": 0.1, "heat": 3.0, "cool": -3.0, "drift": 0.0}
# How firmly each starting value is held until the data says otherwise.
PRIOR_WEIGHT = {"loss": 2000.0, "pull": 200.0, "heat": 2.0, "cool": 2.0, "drift": 20.0}
TERMS = tuple(PRIOR)

MIN_WINDOWS = 48  # a day of usable half-hours before anything is fitted
READY_WINDOWS = 6 * 48  # six days of them before the room counts as ready
MODE_HOURS = 3.0  # hours of heating (or cooling) before that rate counts as learned
LOSS_SPREAD_F = 5.0  # the outside-inside difference must have varied this much
MAX_RATE_F_PER_H = 12.0  # a faster change is a sensor glitch, not the room


@dataclass(frozen=True)
class Window:
    """Half an hour of one room: how fast it moved, and what was going on."""

    rate: float  # °F per hour
    out_diff: float  # outside minus room
    zone_diff: float  # thermostat minus room
    heat: float  # 0..1
    cool: float  # 0..1 (the fitted coefficient is negative)


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
    heat_hours: float
    cool_hours: float
    out_spread: float
    rmse: float | None

    @property
    def learned(self) -> dict[str, bool]:
        """Which terms come from this room's own data rather than a starting value."""
        enough = self.windows >= MIN_WINDOWS
        return {
            "loss": enough and self.out_spread >= LOSS_SPREAD_F,
            "pull": enough,
            "heat": enough and self.heat_hours >= MODE_HOURS,
            "cool": enough and self.cool_hours >= MODE_HOURS,
        }

    @property
    def grade(self) -> str:
        """ "none" (too little to fit), "learning", or "ready"."""
        if self.windows < MIN_WINDOWS:
            return "none"
        return "ready" if self.windows >= READY_WINDOWS and self.learned["loss"] else "learning"

    def rate(
        self, room: float, outside: float, zone: float | None = None, mode: str | None = None
    ) -> float:
        """°F per hour the room would move at, with its vent open in ``mode``."""
        value = self.loss * (outside - room) + self.drift
        if zone is not None:
            value += self.pull * (zone - room)
        if mode == "heating":
            value += self.heat
        elif mode == "cooling":
            value += self.cool
        return value

    def minutes_to(
        self, start: float, target: float, outside: float, mode: str | None, limit_min: int = 360
    ) -> int | None:
        """Minutes for the room to go from ``start`` to ``target``, or None if it won't.

        Stepped five minutes at a time so the loss changes as the room moves.
        """
        rising = target > start
        temp = start
        for step in range(1, limit_min // learning.SAMPLE_EVERY_MIN + 1):
            temp += self.rate(temp, outside, None, mode) * STEP_S / 3600
            if (temp >= target) if rising else (temp <= target):
                return step * learning.SAMPLE_EVERY_MIN
        return None


def windows_from(samples: list[learning.RoomSample]) -> list[Window]:
    """Non-overlapping half-hour windows from one room's readings, oldest first."""
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
                and s.hvac_action != "unknown"
                for s in run[:-1]
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
                if s.hvac_action == action
            ) / len(body)

        if abs(rate) <= MAX_RATE_F_PER_H:
            out.append(Window(rate, outside - room, zone_diff, share("heating"), share("cooling")))
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


def fit(room_id: str, windows: list[Window], *, now: datetime) -> RoomModel:
    """Least squares, with each term held toward its starting value until data outweighs it."""
    heat_hours = sum(w.heat for w in windows) * WINDOW_H
    cool_hours = sum(w.cool for w in windows) * WINDOW_H
    diffs = [w.out_diff for w in windows]
    spread = (max(diffs) - min(diffs)) if diffs else 0.0
    if len(windows) < MIN_WINDOWS:
        return RoomModel(
            room_id,
            None,
            len(windows),
            **PRIOR,
            heat_hours=round(heat_hours, 2),
            cool_hours=round(cool_hours, 2),
            out_spread=round(spread, 2),
            rmse=None,
        )
    rows = [(w.out_diff, w.zone_diff, w.heat, w.cool, 1.0) for w in windows]
    n = len(TERMS)
    ata = [[sum(r[i] * r[j] for r in rows) for j in range(n)] for i in range(n)]
    atb = [sum(r[i] * w.rate for r, w in zip(rows, windows, strict=True)) for i in range(n)]
    for i, term in enumerate(TERMS):
        ata[i][i] += PRIOR_WEIGHT[term]
        atb[i] += PRIOR_WEIGHT[term] * PRIOR[term]
    loss, pull, heat, cool, drift = _solve(ata, atb)
    # Physics, not statistics: walls don't gain heat from the cold, and
    # heating doesn't cool. A fit that says otherwise keeps the starting value.
    if loss <= 0:
        loss = PRIOR["loss"]
    if pull < 0:
        pull = 0.0
    if heat <= 0:
        heat = PRIOR["heat"]
    if cool >= 0:
        cool = PRIOR["cool"]
    beta = (loss, pull, heat, cool, drift)
    sq = sum(
        (w.rate - sum(c * x for c, x in zip(beta, r, strict=True))) ** 2
        for r, w in zip(rows, windows, strict=True)
    )
    return RoomModel(
        room_id=room_id,
        fitted_at=now,
        windows=len(windows),
        loss=round(loss, 5),
        pull=round(pull, 4),
        heat=round(heat, 3),
        cool=round(cool, 3),
        drift=round(drift, 3),
        heat_hours=round(heat_hours, 2),
        cool_hours=round(cool_hours, 2),
        out_spread=round(spread, 2),
        rmse=round(math.sqrt(sq / len(windows)), 3),
    )


async def fit_all(conn: aiosqlite.Connection, *, now: datetime) -> list[RoomModel]:
    """Fit every room from its last 30 days and store the result."""
    since = now - timedelta(days=FIT_DAYS)
    models = []
    for room in await db.get_all_rooms(conn):
        samples = await learning.load(conn, room_id=room.id, since=since)
        models.append(fit(room.id, windows_from(samples), now=now))
    await conn.execute("DELETE FROM room_models")
    await conn.executemany(
        "INSERT INTO room_models(room_id, fitted_at, windows, loss, pull, heat, cool, drift,"
        " heat_hours, cool_hours, out_spread, rmse) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
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
            )
            for m in models
        ],
    )
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
        )
        for r in rows
    }


def describe(model: RoomModel) -> dict[str, Any]:
    """A model as the Smart Learning section shows it. Rates are °F deltas per hour."""
    data = asdict(model)
    data["fitted_at"] = None if model.fitted_at is None else model.fitted_at.isoformat()
    data["hours"] = round(model.windows * WINDOW_H, 1)
    data["learned"] = model.learned
    data["grade"] = model.grade
    return data
