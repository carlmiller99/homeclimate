# House band and what a room follows

## The house band

The house band is one **Heat To** and one **Cool To** temperature for the whole house, set on the **Dashboard**. A room with nothing more specific to follow is kept between the two: heated when it falls below Heat To, cooled when it rises above Cool To, and left alone in between.

- With no band set, nothing changes: a room is only heated or cooled by a hold, a schedule or occupancy. This is how HomeClimate behaved before the band existed.
- Setting a band makes **every room in use** call for heating or cooling whenever it is outside the band. That is a big change on a house that has relied on schedules and occupancy alone, so start with a wide band.
- Cool To must be at least 3 °F (1.7 °C) above Heat To, so a heating cycle's overshoot can never trigger cooling. Both must be between 45 and 95 °F.
- The band does not expire. **Turn Off** clears it.

A room's deadband applies at each edge, exactly as it does around a single target. Eco Mode, door and window pauses, fireplaces and the safety limits all apply to a room following the band.

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

A change to the band or to a room's options takes effect straight away.

## API

- `GET /api/house` — the band (°F, or null) and every room's switches.
- `PUT /api/house` — `house_heat_to` and `house_cool_to` in the display unit, or both null to clear.
- `PUT /api/house/rooms/{room_id}` — `in_use`, `use_schedules`, `use_presence`.
- `POST /api/rooms/active-status` reports `source: "house"` with `heat_to` and `cool_to` for a room following the band.
