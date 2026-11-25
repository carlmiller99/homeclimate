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

**Safety limits are never held back.** A room past its minimum or maximum safety temperature is heated or cooled whatever the building's mode or side, including Off. A fixed mode does not stop a hold, a schedule or occupancy from asking; it only stops the zone from running the other way.

## Auto (Smart Control → Forecasts)

Auto has three levels for each building:

- **Off** (the default). Each zone chooses heating or cooling for itself, as it did before building mode existed.
- **Watch Only.** HomeClimate works out the building's side and logs each time it would have made a zone wait, but holds nothing. Use this to see what On would do.
- **On.** Every zone in the building is kept to the building's side.

### How the side is chosen

The building takes the side of the first cycle that runs in it. After that it switches only when all of these are true:

1. A zone wants the other side and no cycle on the current side is still running. A running cycle is always allowed to finish.
2. That zone has been waiting at least 10 minutes.
3. At least 4 hours have passed since the last switch.
4. The building has switched fewer than 2 times today.
5. The forecast does not rule it out. A switch to cooling needs at least 2 of the next 6 forecast hours above the house band's Cool To; a switch to heating needs 2 below its Heat To. With no house band the limits are 70 °F and 60 °F. With no forecast, this check is skipped.

One exception: when a room is 2 °F (1.1 °C) or more past the target it is waiting for, the building switches as soon as the running cycle ends, without checks 2 to 5.

While a zone waits, its rooms that need the building's current side are still served. The side is remembered across a restart.

Each switch is written to the Logs under Engine ("Main House is now on cooling"), and so is each wait, once per wait.

## API

- `GET /api/building-modes` returns every building with its mode, Auto level, side, a note on what it is waiting for, and the zones waiting.
- `PUT /api/building-modes/{building_id}` takes `mode` (`auto`, `heat_only`, `cool_only`, `off`) and/or `auto_level` (`off`, `watch`, `on`).
