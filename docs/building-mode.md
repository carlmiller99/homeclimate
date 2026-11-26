# Building mode: one side per building

Zones in the same building share its air. If one zone cools while another heats, each works against the other. Building mode keeps every zone in a building on one side, heating or cooling, at a time.

A zone belongs to a building when it is put in one under **My Home**. A zone in no building always chooses for itself.

## The mode (Dashboard)

Each building on the Dashboard has a mode:

| Mode | What it does |
| --- | --- |
| **Auto** | Follows the building's Auto setting, below. This is the default. |
| **Heat Only** | Zones only heat. A room that wants cooling waits. |
| **Cool Only** | Zones only cool. A room that wants heating waits. |
| **Off** | Nothing in the building is heated or cooled. |

The line beside the mode says what the building is doing and names any zone that is waiting.

**Safety limits are never held back.** A room past its minimum or maximum safety temperature is heated or cooled whatever the building's mode or side, including Off, and whatever the room follows. When that runs against the building's side, the cycle only brings the room back inside its limits; it does not go on to the room's usual target. A fixed mode does not stop a hold, a schedule or occupancy from asking; it only stops the zone from running the other way.

Things to know:

- **A cycle that is already running is allowed to finish.** Change a building to Heat Only while a zone is cooling and that zone finishes its cycle first. Until it has, no other zone in the building starts a new cycle, and the Dashboard says what it is waiting for.
- **Off is the exception.** It ends running cycles on the next check, the same way an open door or window does.
- Vacation Mode's own hold on each thermostat is separate from building mode and is not changed by it.

## Auto (Smart Control → Auto Mode)

What Auto means is set for each building, in three parts.

### In Auto, This Building: whether it heats or cools as one

- **Lets Each Zone Decide** (the default). Each zone heats or cools whenever its own rooms need it.
- **Lets Each Zone Decide, and Logs What It Would Do.** HomeClimate works out the building's side and logs each time it would have made a zone wait, but holds nothing. Use this to see what On would do.
- **Heats or Cools as One.** Every zone in the building is kept to the building's side.

### It May Switch Between Heating and Cooling: how often

| Choice | What it allows |
| --- | --- |
| **Several Times a Day** (the default) | Changes at least 4 hours apart, and no more than twice a day. For days that need heat in the morning and cooling in the afternoon. |
| **Once a Day** | One change in any 24 hours. The building heats or cools for the day, and the other side waits. |
| **Once a Week** | One change in any 7 days. |
| **Once a Month** | One change in any 30 days: a change of season. |

The time is counted from the last change, not by the calendar: a building that changed on Tuesday at 3 pm on a weekly limit can next change the following Tuesday at 3 pm.

**The limit always holds.** No room, however far from its target, changes the building's side early. To change sides sooner, set the building to Heat Only or Cool Only on the Dashboard; going back to Auto afterwards starts the count again, and so does choosing a different limit. Safety limits are separate and are never held back (above).

### Switching Threshold

How far past its target on the other side a room must be before the building considers changing sides: 3 °F (1.7 °C) unless changed, from 0 to 10 °F (0 to 5.5 °C). On a building that is heating with a cooling target of 72 °F, a room has to reach 75 °F before its zone's wait counts. The room has to have stayed that far out for the last ten minutes of the wait, so one odd reading does not count. A room that is past its target by less than this simply waits, and outside air (and the [fan](./fan.md), if it is on) does the rest. A room with no temperature sensor of its own is judged by its thermostat's reading.

### How the side is chosen

The building takes the side of the first cycle that starts in it. After that it changes only when all of these are true:

1. A zone wants the other side, with a room at least the switching threshold past its target, and no cycle on the current side is still running. A running cycle is always allowed to finish.
2. That zone has been waiting at least 10 minutes.
3. The limit above allows it.
4. The forecast does not rule it out:
   - **Several Times a Day** and **Once a Day**: a change to cooling needs at least 2 of the next 6 forecast hours above the lowest cooling target in use in the building (its own, a zone's or a room's); a change to heating needs 2 below the highest heating target. That is the outdoor temperature at which the first room starts to need that side.
   - **Once a Week** and **Once a Month**: over the next three days, more forecast hours must call for the new side than for the one the building is on, so one warm afternoon does not use up the change. Mild days that call for neither say nothing against it.
   - With no targets in the building the limits are 70 °F and 60 °F. With no forecast (or, for the weekly and monthly check, less than a day of it), this check is skipped.

On a weekly or monthly limit, taking the first side does not count as a change, so a building that happened to start on the wrong side is not kept there for a month.

A zone only asks for a switch it could use. A zone whose thermostat has no cooling mode, whose cooling is locked out because it is too cold outside, or whose rooms Eco Mode would leave alone, does not make the building switch.

On **Watch Only** nothing is held, so a zone that wants the other side simply runs. The time it spends running counts as its wait and it counts as past the threshold, and the side shown follows the same rules.

A wait that is about to change the building's side (only its ten minutes are still running) is passed on to the building's other zones, so Zone Balance and the other conveniences do not start a run against the side the building is about to take. A wait that the limit, the threshold or the forecast is holding back is not.

While a zone waits, its rooms that need the building's current side are still served. The side is remembered across a restart. Setting a fixed mode, or setting Auto to Off, forgets it; Auto starts again from the next cycle.

Each switch is written to the Logs under Engine ("Main House is now on cooling"), and so is each wait, once per wait.

## API

- `GET /api/building-modes` returns every building with its mode, Auto level, side, a note on what it is waiting for, and the zones waiting.
- `PUT /api/building-modes/{building_id}` takes any of `mode` (`auto`, `heat_only`, `cool_only`, `off`), `auto_level` (`off`, `watch`, `on`), `switching` (`often`, `daily`, `weekly`, `monthly`) and `switch_threshold` (a difference in the display unit; returned in °F).
