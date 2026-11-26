# Targets and what a room follows

## Targets

A **heating target** and a **cooling target**, set on the **Dashboard**. A room with nothing more specific to follow is heated when it falls below the heating target, cooled when it rises above the cooling target, and left alone in between. The two can be the same number: 71 and 71 holds a room at 71, and 71 and 72 keeps it between them.

Targets are set at three levels, and the most specific one wins:

1. a **room**'s own targets
2. its **zone**'s
3. its **building**'s

A level with no targets of its own follows the one above, and the Dashboard shows which. Each building is set separately; there is no single setting for the whole home. A zone that is in no building is set on its own.

- With no targets anywhere above a room, nothing changes for it: it is only heated or cooled by a hold, a schedule or occupancy.
- Setting targets makes **every room in use** under them call for heating or cooling whenever it is outside them. That is a big change on a home that has relied on schedules and occupancy alone.
- The cooling target cannot be below the heating target. Both must be between 45 and 95 °F, and inside the safety limits of the zones they reach: the heating target at least 1 °F below the lowest maximum safety temperature among them, the cooling target at least 1 °F above the highest minimum.
- Targets do not expire. **Clear** removes a level's own targets, so it follows the level above again.
- With the two targets close together, only a room's deadband separates heating from cooling. What limits how often a building changes between them is its mode: Heat Only or Cool Only, or Auto set to On with a limit of your choosing. See [Building mode](./building-mode.md). A zone in no building, or a building whose Auto is Off, has no such limit.
- The safety-limit check looks only at the zones the targets can reach: a building's zones, the one zone, or a room's zone.
- A zone that leaves its building for none or for one with no targets, or whose building is deleted, keeps the targets it was following as its own.

A room's deadband applies at each target, exactly as it does around a single target: heating starts once the room is a deadband below the heating target and stops at it; cooling starts a deadband above the cooling target and stops at it. A room resting between the two is left out of any cycle running for other rooms.

Eco Mode, door and window pauses, fireplaces and the safety limits all apply to a room following its targets. If the targets are wider than a zone's safety limits, the safety limits act first. Vacation Mode pauses targets along with schedules and occupancy.

Things to know before setting them:

- With targets set, HomeClimate manages those zones around the clock, the way an all-day schedule would, so a setpoint changed at the thermostat is put back.
- A room with no working temperature sensor does not follow its targets, because HomeClimate can't tell where it sits against them. Its holds, schedules and safety limits work as before, going by the thermostat's reading.
- On a heat pump zone, a room's coming schedule can still start early; the early warm-up takes over from the targets.

### Upgrading from the house band

Versions before 0.5.17 had one Heat To and Cool To for the whole house. On the first start after upgrading, those two numbers become the targets of every building, and of every zone that is in no building, so every room is kept where it was. Nothing needs doing. The same happens when a backup from an earlier version is restored.

## A band on a schedule, a hold or occupancy

A schedule block, a temporary hold and a room's occupancy target each hold one temperature by default. Give any of them a **Cool To** and that temperature becomes its **Heat To**: the room is kept between the two, exactly as it is with its targets, for as long as that block, hold or occupancy is what the room follows.

- **Schedule block**: Smart Control → Schedules → add or edit a block → Cool To.
- **Hold**: the Dashboard's hold dialog → Cool To.
- **Occupancy target**: the room's settings in My Home → Cool To, under the presence-triggered temperature.

Leave Cool To blank for a single target. The same rules as targets apply: Cool To not below the target, both between 45 and 95 °F, and inside every zone's safety limits.

A band belongs to the target it was set on:

- Change a block's or a room's target without naming a Cool To and the band moves with it. If the new target would be above the Cool To, or take the band outside the limits, the band is dropped and the target becomes a single one, so MQTT and automations can always move a target.
- A hold set without `cool_to` (from MQTT, an automation, or any other client) is a single target, even on a room whose last hold was a band.
- Copying a schedule block copies its band.
- Through the API a banded target still reports `target_temp` (its Heat To), with `cool_to` beside it. MQTT's hold entity shows the Heat To.

If a room's own sensors stop reporting, a band on its hold, schedule or occupancy target goes by the thermostat's reading, as a single target does. (A room that is only following its targets sits out instead.)

## What a room follows

Most specific first:

1. a **hold**
2. an active **schedule**
3. **occupancy** (the room's occupied target)
4. its **targets**: the room's own, else its zone's, else its building's

Holds, schedules and occupancy each have one target, not a band.

## Per-room options

Each room on the Dashboard has **Options**:

| Switch | Off means |
|---|---|
| **Room In Use** | The room asks for no heating or cooling, and its schedules and occupancy sensors are ignored. A hold still works and its safety limits still apply. The Dashboard marks it **Not In Use**. |
| **Follow Its Schedules** | The room's schedules are skipped, not deleted, and it follows its targets instead. |
| **Follow Occupancy** | Occupancy gives the room no target of its own; it follows its targets instead. |

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

- `GET /api/house` — `targets`, one entry per level that has its own (`scope`, `scope_id`, `house_heat_to`, `house_cool_to`, in °F), and every room's switches. The top-level `house_heat_to` and `house_cool_to` are null except on a home with no building or zone yet to take over an earlier version's band.
- `PUT /api/house/targets/{scope}/{scope_id}` — `scope` is `building`, `zone` or `room`; `scope_id` is the building id, the zone's thermostat entity id, or the room id. Send `house_heat_to` and `house_cool_to` in the display unit, or both null to clear. Both keys are required. This replaces `PUT /api/house`, which is gone.
- `PUT /api/house/rooms/{room_id}` — `in_use`, `use_schedules`, `use_presence`.
- `PUT /api/house/rooms/{room_id}/calendar` — `entity_id`, `match_text`, `lead_min`; `DELETE` to stop following.
- `POST /api/rooms/active-status` reports `source: "house"` with `heat_to` and `cool_to` for a room following its targets.
