# Fan

A building held to heating leaves a room that is too warm to cool by itself, and one held to cooling leaves a cold room to warm by itself. When another room of the same zone is closer to where that room should be, running the air handler's fan with nothing else on mixes the two. That is all this feature does: it moves air, and it never heats or cools.

It is set per zone under **Smart Control → Fan**:

- **Off** (the default). The fan is left to the thermostat.
- **Watch Only.** HomeClimate logs each time it would have run the fan, and does not touch it. Use this to see what On would do.
- **On.** HomeClimate turns the thermostat's fan on, and back to auto afterwards.

## When it runs

All of these have to be true:

1. The zone is idle: no cycle is running and the thermostat is not heating or cooling.
2. Its building holds it to one side: the building is set to Heat Only or Cool Only, or to Auto with Auto set to On (see [Building mode](./building-mode.md)). The fan works the other side, the one the building is not serving. A zone in no building, or in a building whose Auto is Off, heats and cools for itself and has no use for it.
3. A room is at least 0.5 °F (0.3 °C) past its target on that side: above its cooling target in a building that is heating, or below its heating target in one that is cooling. A room with a single target is measured against that.
4. Another room of the zone is at least 1.5 °F (0.8 °C) closer to it: cooler than the warm room, or warmer than the cold one.

It stops when the room is back at its target, when the two rooms are within 0.75 °F (0.4 °C) of each other, or when a cycle starts.

## Limits

- **No more than 30 minutes in any hour.**
- **Not for 15 minutes after a cooling run**, while the coil is wet: running the fan then puts the moisture back into the house.
- **A room paused by an open door or window counts for nothing**, either as the reason or as the room to mix with. A paused zone does not run the fan at all.
- **Not while the system is off, in Vacation Mode, or while a fireplace is lit** in one of the zone's rooms.
- **A fan somebody else turned on is left alone.** HomeClimate only turns off a fan it turned on, and not even that one if it has been changed at the thermostat since.
- Rooms that are not in use are left out.

When the fan starts, the vents of the room and of the rooms it is being mixed with are opened. Each start, stop and "would run" is written to the Logs under Engine.

The thermostat has to offer `on` and `auto` fan settings in Home Assistant. One that does not is marked on the page, and its fan is never touched.

## Outside air intake

Some air handlers have a duct that brings in outside air whenever the fan runs. On those, running the fan does more than mix rooms: it draws the outside in. So each zone has an **Outside Air Intake** setting under **My Home → Edit Zone**:

- **Yes.** The fan only runs by itself while outside air would help the room: cooler than a room that is too warm, or warmer than one that is too cold. With no outside temperature (Settings → Sensors), it does not run.
- **No**, or **Not Sure** (the default, treated as No). The outside temperature is not considered.

### Test

**Test**, beside the setting, runs the fan alone for 10 minutes and compares how the zone's rooms moved with the outside temperature. It needs the zone to be idle, a room temperature, an outside temperature, and at least 10 °F (5.6 °C) between inside and outside.

The result is a hint and no more. Rooms moving 0.5 °F (0.3 °C) or more toward the outside temperature could mean an intake, but mixing between rooms and ducts that run through an attic or crawl space do the same; and an intake whose damper stayed shut shows nothing. Look at the air handler for a duct to the outside before choosing Yes. A cycle or a pause that starts during the test cuts it short, and it then says nothing.

## API

- `GET /api/fan` — each zone's level, intake setting, whether its thermostat's fan can be switched, whether HomeClimate has it running, a note on what it is doing or why not, the minutes it ran in the last hour, and the last test.
- `PUT /api/zones/{entity_id}` — `fan_level` (`off`, `watch`, `on`) and `air_intake` (`yes`, `no`, `unsure`).
- `POST /api/fan/{entity_id}/test` — start the test.
