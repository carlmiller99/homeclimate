# House band and what a room follows

## The house band

The house band is one **Heat To** and one **Cool To** temperature for the whole house, set on the **Dashboard**. A room with nothing more specific to follow is kept between the two: heated when it falls below Heat To, cooled when it rises above Cool To, and left alone in between.

- With no band set, nothing changes: a room is only heated or cooled by a hold, a schedule or occupancy. This is how HomeClimate behaved before the band existed.
- Setting a band makes **every room in use** call for heating or cooling whenever it is outside the band. That is a big change on a house that has relied on schedules and occupancy alone, so start with a wide band.
- Cool To must be at least 3 °F (1.7 °C) above Heat To. Both must be between 45 and 95 °F, and inside every zone's safety limits: Heat To at least 1 °F below the lowest maximum safety temperature, Cool To at least 1 °F above the highest minimum.
- The band does not expire. **Turn Off** clears it.

A room's deadband applies at each edge, exactly as it does around a single target: heating starts once the room is a deadband below Heat To and stops at Heat To; cooling starts a deadband above Cool To and stops at Cool To. A room resting inside the band is left out of any cycle running for other rooms.

Eco Mode, door and window pauses, fireplaces and the safety limits all apply to a room following the band. Vacation Mode pauses the band along with schedules and occupancy.

Things to know before turning it on:

- With a band set, HomeClimate manages every zone around the clock, the way an all-day schedule would, so a setpoint changed at the thermostat is put back.
- A room with no working temperature sensor is judged on its zone thermostat's reading.
- On a heat pump zone, a room's coming schedule can still start early; the early warm-up takes over from the band.

## What a room follows

Most specific first:

1. a **hold**
2. an active **schedule**
3. **occupancy** (the room's occupied target)
4. the **house band**

Holds, schedules and occupancy each have one target, not a band.

## Per-room options

Each room on the Dashboard has **Options**:

| Switch | Off means |
|---|---|
| **Room In Use** | The room asks for no heating or cooling, and its schedules and occupancy sensors are ignored. A hold still works and its safety limits still apply. The Dashboard marks it **Not In Use**. |
| **Follow Its Schedules** | The room's schedules are skipped, not deleted, and it follows the house band instead. |
| **Follow Occupancy** | Occupancy gives the room no target of its own; it follows the house band instead. |

All three are on for every room until changed. Cancelling a hold is how a held room goes back to what it follows.

A change to the band or to a room's options is applied straight away, though the equipment's own protections (minimum off time, the heat pump's switchover wait) can still delay a start. Turning the band off, or marking a room not in use, ends a cycle that was running only for those rooms, so Turn Off asks first.

## API

- `GET /api/house` — the band (°F, or null) and every room's switches.
- `PUT /api/house` — `house_heat_to` and `house_cool_to` in the display unit, or both null to clear. Both keys are required.
- `PUT /api/house/rooms/{room_id}` — `in_use`, `use_schedules`, `use_presence`.
- `POST /api/rooms/active-status` reports `source: "house"` with `heat_to` and `cool_to` for a room following the band.
