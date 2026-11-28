# Fan

A building held to heating leaves a room that is too warm to cool by itself, and one held to cooling leaves a cold room to warm by itself. When another room of the same zone is closer to where that room should be, running the air handler's fan with nothing else on mixes the two. That is all this feature does: it moves air, and it never heats or cools.

It is set per zone under **Smart Control → Fan**:

- **Off** (the default). The fan is left to the thermostat.
- **Watch Only.** HomeClimate logs each time it would have run the fan, and does not touch it. Use this to see what On would do.
- **On.** HomeClimate turns the thermostat's fan on, and back to auto afterwards.

## When it runs

All of these have to be true:

1. The zone is idle: no cycle is running and the thermostat is not heating or cooling.
2. It is held to one side: the zone (or its building) is set to Heat or Cool, or it is in Auto in a building (see [Building and zone modes](./building-mode.md)). The fan works the other side, the one the zone is not serving. A zone in no building in Auto chooses freely and has no use for it.
3. A room is at least 0.5 °F (0.3 °C) past its target on that side: above its cooling target in a building that is heating, or below its heating target in one that is cooling. A room kept to one number (a single target, or two targets that are the same) has to be 2.5 °F (1.4 °C) past it, because a cycle overshoots by about that much and that alone is no reason to run the fan.
4. Another room of the zone is at least 1.5 °F (0.8 °C) closer to it: cooler than the warm room, or warmer than the cold one. A room that is itself at or past its own target on that side is no help, since mixing would push it further out.

It stops when the room is back at its target, when the two rooms are within 0.75 °F (0.4 °C) of each other, or when a cycle starts. Only the room the fan is running for keeps it going on those looser terms; another room has to be far enough out to start it.

## Limits

- **No more than 30 minutes in any hour.**
- **Not for 15 minutes after HomeClimate starts**, since it cannot know whether a cooling run had just ended.
- **Not for 15 minutes after any run.** After cooling the coil is wet, and running the fan then puts the moisture back into the house; after either, the rooms are still settling. Defrosting and drying count as runs.
- **A room paused by an open door or window counts for nothing**, either as the reason or as the room to mix with. A paused zone does not run the fan at all.
- **Not while the system is off, in Vacation Mode, or while a fireplace is lit** in one of the zone's rooms.
- **A fan somebody else turned on is left alone.** HomeClimate only turns off a fan it turned on. That one it always sets back to auto when it is done: after a restart, when its zone is deleted, and when the thermostat did not answer the first time (it keeps trying). If HomeClimate cannot read the zones at all, it hands every fan back.
- In Developer Mode no fan is turned on; what would have run is logged once, as with Watch Only. A fan HomeClimate had already turned on is still set back to auto when it is done.
- While a thermostat is unavailable in Home Assistant, a fan HomeClimate turned on stays remembered, and is set back to auto when the thermostat returns.
- After a restart, a fan HomeClimate had on is set back to auto if it is no longer wanted, even if somebody turned it on by hand in the meantime.
- Rooms that are not in use are left out.

When the fan starts, the vents of the room and of the rooms it is being mixed with are opened. Each start, stop and "would run" is written to the Logs under Engine.

The thermostat has to offer `on` and `auto` fan settings in Home Assistant. One that does not is marked on the page, and its fan is never touched.

## Outside air intake

Some air handlers have a duct that brings in outside air whenever the fan runs. On those, running the fan does more than mix rooms: it draws the outside in. So each zone has an **Outside Air Intake** setting under **My Home → Edit Zone**:

- **Yes.** The fan only runs by itself while outside air would help the room: cooler than a room that is too warm, or warmer than one that is too cold. With no outside temperature (My Home → Outside), it does not run.
- **No**, or **Not Sure** (the default, treated as No). The outside temperature is not considered.

Look at the air handler for a duct to the outside before choosing Yes.

## API

- `GET /api/fan` — each zone's level, intake setting, whether its thermostat's fan can be switched, whether HomeClimate has it running, a note on what it is doing or why not, and the minutes it ran in the last hour.
- `PUT /api/zones/{entity_id}` — `fan_level` (`off`, `watch`, `on`) and `air_intake` (`yes`, `no`, `unsure`).

## Smart Learning

Time the fan runs alone is left out of what [Smart Learning](./smart-learning.md) learns about a room, since the room is not drifting by itself then. That includes a fan somebody set to On at the thermostat: a zone whose fan is left on all the time gives Smart Learning nothing to learn its idle drift from.
