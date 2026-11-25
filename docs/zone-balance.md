# Zone Balance

**Smart Control → Zone Balance** keeps the zones of one building within a few degrees of each other.

When one zone of a building is in use and another has been left to drift, the gap between them grows until the used zone is heating or cooling the other through the walls and doors. With Zone Balance on, a zone further behind than the gap limit is brought back to the limit.

## Settings

Each building has its own:

- **Balance**: **Off** (the default), **Watch Only** (logs what it would do and does nothing) or **On**.
- **Gap Limit**: how far apart zones may be. 3 °F to start with; 2 to 10 °F (1.2 to 5.5 °C).

The section also shows each zone's temperature, how far apart the warmest and coolest are, and what is being balanced right now. It looks again every half minute. A room in a run for balance shows **Zone Balance** on the Dashboard.

## The rules

- **Only in the direction the building is working in.** That is the side its zones are held to under [One Side Per Building](./building-mode.md) (or its fixed Heat Only or Cool Only mode), and otherwise the way its zones are running at the moment. A side that is only being watched does not count. With nothing running and no side, nothing is balanced. A building that is Off is never balanced.
- **Only against a zone that is in use.** A zone counts as in use while a hold, a schedule or occupancy is asking for one of its rooms. A zone that only follows the house band does not count, so an empty building is left alone.
- **The least that is needed.** When heating, a zone more than the limit colder than the warmest in-use zone is heated to that zone's temperature less the limit, to the nearest half degree. Cooling is the mirror of that.
- **A zone's temperature** is the average of its rooms that are in use and have a reading. A room set aside for a lit fireplace is left out, so a fire in one zone does not make the others look cold.
- **Which rooms are heated or cooled.** Rooms in the lagging zone that are in use and follow nothing more specific than the house band. A room with a hold, a schedule or occupancy is left to it. A room following the house band is balanced only to a temperature inside its band, and only when the band is not already asking for as much.
- **It gives way to any room that calls for itself.** Before the zone starts anything, if a room past a safety limit, on a hold, a schedule or occupancy, or outside the house band is asking for heating or cooling, Zone Balance sits out and the zone chooses exactly as it would with Zone Balance off. A run with nothing left to do but balancing rooms is ended for a room that calls for the other direction, once it has had its minimum runtime. A balancing room that goes past a safety limit is protected like any other. While the zone runs for someone else, balancing rooms may join if the direction suits them.
- **Pauses still apply.** A zone or room paused for an open door or window, or a room set aside for a fireplace, is not heated or cooled for balance. Nothing is balanced in Vacation Mode.
- **Inside the zone's own limits.** The target is held to the zone's minimum and maximum setpoints. Eco Mode relaxes it like any other target.
- Once a room has started a run for balance it is kept in it, at the target it started with, until the run ends by the usual rules (or it gives way to a room that calls the other way, or a safety limit takes it over, as above). The call itself comes and goes as the other zone's temperature moves, and a run is not cut short when it lapses, including when Balance is switched Off.
- **How close it holds.** The target is rounded to half a degree and a room starts only once it is more than its deadband short, so the gap actually held is the limit plus the deadband, give or take a quarter of a degree.
- **A room that calls blocks balancing even if it cannot be served.** A room asking for cooling in a building set to Heat Only, one held back by a cooling lockout, or one Eco Mode would relax still counts as calling, so a balancing run is not started for its zone until it stops. This errs on the side of doing nothing. A run already under way is treated differently where the building is set to Heat Only or Cool Only: a call for the other side cannot be answered by any cycle, so it does not end the run (a room past a safety limit still does). Where the building chooses its own side, the call does end the run, so the zone is idle and can wait for the building to switch. A cooling lockout or Eco Mode is not looked at here, so a call they would hold back does end a running balance run after its minimum runtime.
- **A balancing run never sets or holds the building's side.** A run for nothing but balancing rooms is not counted when the building works out which side it is on, and if the building turns to the other side while one is going, the run ends once it has had its minimum runtime. Another zone waiting for the side waits no longer than that.
- **A call waiting to coast is not disturbed.** While a room in the zone is waiting to drift to its target (Let Rooms Coast), no balancing run is started in that zone.
- **With an airflow floor, a run can last a little longer than it would with Zone Balance off.** When the floor keeps a finished room's vent open and that room then reads just under its target again, the run carries on for it and for the balancing rooms until it reads at target; with Zone Balance off the run would already have ended. A room calling the other way waits for that, normally a few minutes.
- **When nothing can answer.** If every room in the lagging zone has its own hold, schedule or occupancy target, or is paused, the zone is asked but nothing runs for it. The section says so.

This can run a zone nobody is in. That is the point of it, and why it is off until you turn it on: heating an empty zone with electric strip heat to keep it within 3 °F of an occupied one costs money. Try Watch Only first and read the log.

Each time a zone is first asked (or would be, on Watch Only), a line is logged under Engine. Rooms heated or cooled for balance show as "zone balance" in a cycle's detail.

## API

- `GET /api/zone-balance`: each building's level, gap limit (°F), direction, spread and zones.
- `PUT /api/zone-balance/{building_id}`: `level` (`off`, `watch`, `on`) and `zone_gap` (a difference, in the display unit).
