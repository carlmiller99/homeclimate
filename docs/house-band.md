# House band and what a room follows

## The house band

The house band is one **Heat To** and one **Cool To** temperature for the whole house, set on the **Dashboard**. A room with nothing more specific to follow is kept between the two: heated when it falls below Heat To, cooled when it rises above Cool To, and left alone in between.

- With no band set, nothing changes: a room is only heated or cooled by a hold, a schedule or occupancy. This is how HomeClimate behaved before the band existed.
- Setting a band makes **every room in use** call for heating or cooling whenever it is outside the band. That is a big change on a house that has relied on schedules and occupancy alone, so start with a wide band.
- Cool To must be at least 3 °F (1.7 °C) above Heat To. Both must be between 45 and 95 °F, and inside every zone's safety limits: Heat To at least 1 °F below the lowest maximum safety temperature, Cool To at least 1 °F above the highest minimum.
- The band does not expire. **Turn Off** clears it.

A room's deadband applies at each edge, exactly as it does around a single target: heating starts once the room is a deadband below Heat To and stops at Heat To; cooling starts a deadband above Cool To and stops at Cool To. A room resting inside the band is left out of any cycle running for other rooms.

Eco Mode, door and window pauses, fireplaces and the safety limits all apply to a room following the band. If the band is wider than a zone's safety limits, the safety limits act first. Vacation Mode pauses the band along with schedules and occupancy.

Things to know before turning it on:

- With a band set, HomeClimate manages every zone around the clock, the way an all-day schedule would, so a setpoint changed at the thermostat is put back.
- A room with no working temperature sensor does not follow the house band, because HomeClimate can't tell where it sits in it. Its holds, schedules and safety limits work as before, going by the thermostat's reading.
- On a heat pump zone, a room's coming schedule can still start early; the early warm-up takes over from the band.

## A band on a schedule, a hold or occupancy

A schedule block, a temporary hold and a room's occupancy target each hold one temperature by default. Give any of them a **Cool To** and that temperature becomes its **Heat To**: the room is kept between the two, exactly as it is with the house band, for as long as that block, hold or occupancy is what the room follows.

- **Schedule block**: Smart Control → Schedules → add or edit a block → Cool To.
- **Hold**: the Dashboard's hold dialog → Cool To.
- **Occupancy target**: the room's settings in My Home → Cool To, under the presence-triggered temperature.

Leave Cool To blank for a single target. The same rules as the house band apply: Cool To at least 3 °F (1.7 °C) above the target, both between 45 and 95 °F, and inside every zone's safety limits.

A band belongs to the target it was set on:

- Change a block's or a room's target without naming a Cool To and the band moves with it. If the new target would leave less than 3 °F to the Cool To, or take the band outside the limits, the band is dropped and the target becomes a single one, so MQTT and automations can always move a target.
- A hold set without `cool_to` (from MQTT, an automation, or any other client) is a single target, even on a room whose last hold was a band.
- Copying a schedule block copies its band.
- Through the API a banded target still reports `target_temp` (its Heat To), with `cool_to` beside it. MQTT's hold entity shows the Heat To.

If a room's own sensors stop reporting, a band on its hold, schedule or occupancy target goes by the thermostat's reading, as a single target does. (A room that is only following the house band sits out instead.)

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

All three are on for every room until changed.

### Room In Use from a calendar

Under **Smart Control → Schedules → Rooms In Use by Calendar**, a room's In Use can follow a Home Assistant calendar instead of being set by hand, for rooms that are only lived in some of the time.

- The room is in use while an event is on, and from **Get Ready Ahead** (2 hours by default, up to 24) before one starts, so it is at temperature on arrival. The lead is a fixed time; on a heat pump zone in cold weather, allow more.
- **Only Events Containing** limits it to events whose title contains that text; leave it empty for any event. Every event in the window is looked at, so an unrelated event at the same time does not hide the one that matters.
- The calendar is read once a minute through Home Assistant's event list. New or changed events show up as fast as the calendar integration itself refreshes.
- If the calendar can't be read (renamed, removed, its integration down), the room first keeps what the calendar last said. After 30 minutes it is treated as **in use** until the calendar answers again, a warning is logged, and the card says so. While Home Assistant itself is disconnected, nothing is concluded.
- While a room follows a calendar its In Use switch on the Dashboard is locked. **Stop Following** hands it back, keeping the state it had.
- All-day events run from midnight in the house's time zone.

## API

- `GET /api/house` — the band (°F, or null) and every room's switches.
- `PUT /api/house` — `house_heat_to` and `house_cool_to` in the display unit, or both null to clear. Both keys are required.
- `PUT /api/house/rooms/{room_id}` — `in_use`, `use_schedules`, `use_presence`.
- `PUT /api/house/rooms/{room_id}/calendar` — `entity_id`, `match_text`, `lead_min`; `DELETE` to stop following.
- `POST /api/rooms/active-status` reports `source: "house"` with `heat_to` and `cool_to` for a room following the band.
