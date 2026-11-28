# Building and zone modes

Zones in the same building share its air. If one zone cools while another heats, each works against the other. Each building and each zone has a mode that says when it may heat or cool, and a building can keep its zones from running opposite each other.

A zone belongs to a building when it is put in one under **My Home**.

## The building's mode (Dashboard)

Each building on the Dashboard has a mode:

| Mode | What it does |
| --- | --- |
| **Auto** | Each zone heats or cools as its rooms need, within the limits in Smart Control → Auto Mode. This is the default. |
| **Heat Only** | Zones only heat. A room that wants cooling waits. |
| **Cool Only** | Zones only cool. A room that wants heating waits. |
| **Off** | Nothing in the building is heated or cooled. |

The line beside the mode says what the building is doing and names any zone that is waiting.

## A zone's mode (Dashboard → the zone)

Tap a zone's card to open its settings. Its **Mode** is one of:

- **Follow Building** (the default): the building's mode.
- **Auto**, **Heat**, **Cool** or **Off**: the zone's own, whatever the building is set to.

A zone in no building has nothing to follow, so Follow Building is not offered and the zone is in Auto, with no switching limit. The zone's card shows its mode beside what it is doing, and says why it is waiting when it is.

The same dialog holds the zone's **Baseline Temperature Target**, the Heating Target and Cooling Target its rooms follow unless they have their own. See [targets](./house-band.md).

**Safety limits are never held back.** A room past its minimum or maximum safety temperature is heated or cooled whatever the mode, including Off. When that runs against the mode, the cycle only brings the room back inside its limits; it does not go on to the room's usual target. A fixed mode does not stop a hold, a schedule or occupancy from asking; it only stops the zone from running the other way.

Things to know:

- **A cycle that is already running is allowed to finish.** Change a zone to Heat while it is cooling and it finishes its cycle first.
- **Off is the exception.** It ends running cycles on the next check, the same way an open door or window does.
- Vacation Mode's own hold on each thermostat is separate and is not changed by the modes.

## Auto Mode (Smart Control → Auto Mode)

Each building has the limits its zones keep to in Auto.

### Zones May Run Opposite Each Other

**Yes** (the default) lets each zone heat or cool on its own. **No** lets one zone heat while another coasts, but never while another cools. This holds for zones set to Heat or Cool too:

- No zone starts a cycle while another zone in the building runs the other way. A running cycle always finishes.
- Two idle zones cannot start opposite cycles in the same minute.
- A zone in use (a hold, a schedule or occupancy is asking for one of its rooms) goes before one nobody is using.

The Dashboard names a zone that waits, and the zone it waits for.

### May Switch Between Heating and Cooling

How often a zone in Auto may change sides. Each zone counts its own switches.

| Choice | What it allows |
| --- | --- |
| **Several Times a Day** (the default) | Changes at least 4 hours apart, and no more than twice a day. For days that need heat in the morning and cooling in the afternoon. |
| **Once a Day** | One change in any 24 hours. |
| **Once a Week** | One change in any 7 days. |
| **Once a Month** | One change in any 30 days: a change of season. |

The time is counted from the zone's last change, not by the calendar. Choosing a different limit starts every zone's count again.

**The limit always holds.** No room, however far from its target, switches its zone early, and Keep Zones Within never does either. To change sides sooner, set the zone (or the building) to Heat or Cool. Safety limits are separate and are never held back.

### Threshold for Switching Mode

How far past its target on the other side a room must be before its zone considers switching: 3 °F (1.7 °C) unless changed, from 0 to 10 °F (0 to 5.5 °C). On a zone that is heating with a Cooling Target of 72 °F, a room has to reach 75 °F before the zone's wait counts. The room has to have stayed that far out for the last ten minutes of the wait. A room with no temperature sensor of its own is judged by its thermostat's reading.

### How a zone's side is chosen

A zone in Auto takes the side of its first cycle. After that it switches only when all of these are true:

1. A room in the zone is at least the threshold past its target on the other side, and no cycle on the current side is still running.
2. The zone has been waiting at least 10 minutes.
3. The limit above allows it.
4. The forecast does not rule it out:
   - **Several Times a Day** and **Once a Day**: a change to cooling needs at least 2 of the next 6 forecast hours above the lowest Cooling Target in use in the building; a change to heating needs 2 below the highest Heating Target.
   - **Once a Week** and **Once a Month**: over the next three days, more forecast hours must call for the new side than for the one the zone is on, so one warm afternoon does not use up the change.
   - With no targets the limits are 70 °F and 60 °F. With no forecast, this check is skipped.

On a weekly or monthly limit, taking the first side does not count as a change. A zone whose thermostat has no cooling mode, whose cooling is locked out, or whose rooms Eco Mode would leave alone does not switch for them.

The side is remembered across a restart. Setting the zone to Heat, Cool or Off forgets it. Each switch is written to the Logs under Engine ("North Wing is now on cooling").

### Keep Zones Within

How far apart the building's zones may drift, and a switch to turn it on. A zone left behind is heated or cooled to stay this close to the zones in use. The **Right Now** panel shows each zone's temperature, the gap, and why a zone has not switched yet. See [Keep Zones Within](./zone-balance.md) for the rules.

## API

- `GET /api/building-modes` returns every building with its mode, `opposite_allowed`, `switching`, `switch_threshold`, and its zones: each zone's `mode`, `effective_mode`, `side`, a `note` on what it is waiting for, `held_for` (the side it could not start because another zone runs the other way) and `in_use`.
- `PUT /api/building-modes/{building_id}` takes any of `mode` (`auto`, `heat_only`, `cool_only`, `off`), `opposite_allowed` (true or false), `switching` (`often`, `daily`, `weekly`, `monthly`) and `switch_threshold` (a difference in the display unit; returned in °F).
- A zone's mode is `mode` on `PUT /api/zones/{thermostat_entity_id}`: `follow`, `auto`, `heat`, `cool` or `off`.
