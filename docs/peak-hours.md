# Peak Hours

**Smart Control → Peak Hours** is for a home whose electricity costs more at certain hours. For a while before those hours, HomeClimate does some of the heating or cooling early: rooms that follow a band are worked a little way into it, so that during the peak they can drift back across the band before anything has to run.

It is off until you turn it on.

## Settings

- **Bank Ahead of Peak Hours**: the switch.
- **The Peak Hours**: when electricity costs most, in the house's time. An end earlier than the start runs into the next day.
- **On These Days**: weekdays to start with.
- **Start Banking**: how long before the peak to start, 30 to 180 minutes (90 to start with).
- **How Far to Bank**: how far inside the band's edge to take a room, 1 to 5 °F (0.6 to 2.7 °C); 2 °F to start with.

The section says when the next peak is, when banking for it starts, and when one is under way. A room in a run that is banking shows **Banking** on the Dashboard, and "banking for peak hours" in the cycle's detail.

## The rules

- **Never past the band.** Before hours that will be hot, a room is cooled to its Cool To less the depth; before hours that will be cold, warmed to its Heat To plus the depth. Either way it stays at least 1 °F and the room's deadband short of the band's other edge (in a band too narrow for that, it goes to the middle), and inside the zone's setpoint limits.
- **Only rooms following a band**: the house band, or a schedule or occupancy target with a Cool To. A room with a single target has nowhere to bank, and a hold is never touched.
- **Only when the forecast calls for it.** The direction comes from the forecast for the peak hours, corrected as it is elsewhere: cooling if it will be warmer outside than the band's Cool To, heating if colder than its Heat To, nothing if neither. With no forecast, the outside sensor's reading stands in. With neither, nothing is banked.
- **Never against the side a building is held to** under One Side Per Building.
- **Not warmed on auxiliary heat.** A heat pump expecting its strips does not bank heat with them. Heat pump protection applies to a banking run like any other.
- **It never decides the zone's direction against anyone else.** When the zone chooses between heating and cooling, rooms being banked count only if no other room has a say. A room past a safety limit, a hold, a schedule or occupancy always comes first.
- **Nothing is banked during the peak itself.** The band's own edges still call for heating or cooling when a room reaches them.
- A room that has started a banking run stays in it, at the target it started with, until the run ends by the usual rules. If the peak begins first, banking stops as soon as the run has had its minimum runtime: the room goes back to its band and the run ends by itself.
- During the lead time a room is held at its banked target like any other target, so a long lead can mean several short runs.
- Eco Mode relaxes a banked target as it does any other, so on the hottest and coldest days, when Eco is relaxing targets, little or nothing is banked.
- Pauses, the fireplace, Vacation Mode and Eco Mode apply as to any room.

Banking costs a little extra energy for the sake of moving it to cheaper hours: a house held cooler or warmer loses more. It is worth it only when the price difference is real.

## API

- `GET /api/peak-hours`: the settings and the coming peak.
- `PUT /api/peak-hours`: any of `enabled`, `start`, `end` (house-local `HH:MM`), `days` (0 is Monday), `lead_min`, `peak_depth` (a difference, in the display unit).
