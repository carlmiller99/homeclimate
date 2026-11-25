# Zone Balance

**Smart Control → Zone Balance** keeps the zones of one building within a few degrees of each other.

When one zone of a building is in use and another has been left to drift, the gap between them grows until the used zone is heating or cooling the other through the walls and doors. With Zone Balance on, a zone further behind than the gap limit is brought back to the limit.

## Settings

Each building has its own:

- **Balance**: **Off** (the default), **Watch Only** (logs what it would do and does nothing) or **On**.
- **Gap Limit**: how far apart zones may be. 3 °F to start with; 2 to 10 °F (1.1 to 5.6 °C).

The section also shows each zone's temperature, how far apart the warmest and coolest are, and what is being balanced right now.

## The rules

- **Only in the direction the building is working in.** That is the building's side under [One Side Per Building](./building-mode.md) (or its fixed Heat Only or Cool Only mode), and otherwise the way its zones are running at the moment. With nothing running and no side, nothing is balanced. A building that is Off is never balanced.
- **Only against a zone that is in use.** A zone counts as in use while a hold, a schedule or occupancy is asking for one of its rooms. A zone that only follows the house band does not count, so an empty building is left alone.
- **The least that is needed.** When heating, a zone more than the limit colder than the warmest in-use zone is heated to that zone's temperature less the limit, to the nearest half degree. Cooling is the mirror of that.
- **A zone's temperature** is the average of its rooms that are in use and have a reading. A room set aside for a lit fireplace is left out, so a fire in one zone does not make the others look cold.
- **Which rooms are heated or cooled.** Rooms in the lagging zone that are in use and follow nothing more specific than the house band. A room with a hold, a schedule or occupancy is left to it. A room following the house band is balanced only to a temperature inside its band, and only when the band is not already asking for as much.
- **Pauses still apply.** A zone or room paused for an open door or window, or a room set aside for a fireplace, is not heated or cooled for balance. Nothing is balanced in Vacation Mode.
- **Inside the zone's own limits.** The target is held to the zone's minimum and maximum setpoints. Eco Mode relaxes it like any other target.
- Once a room has started a run for balance it is kept to the end of that run.

This can run a zone nobody is in. That is the point of it, and why it is off until you turn it on: heating an empty zone with electric strip heat to keep it within 3 °F of an occupied one costs money. Try Watch Only first and read the log.

Each time a zone starts being balanced, a line is logged under Engine. Rooms heated or cooled for balance show as "zone balance" in a cycle's detail.

## API

- `GET /api/zone-balance`: each building's level, gap limit (°F), direction, spread and zones.
- `PUT /api/zone-balance/{building_id}`: `level` (`off`, `watch`, `on`) and `zone_gap` (a difference, in the display unit).
