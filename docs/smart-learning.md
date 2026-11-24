# Smart Learning

Smart Learning is where HomeClimate learns how each room heats and cools so it can plan ahead. The first part is in place: a recorder that takes a reading of every room every 5 minutes. Recording commands nothing. It does not move a vent or change a thermostat.

Find it under **Smart Control → Smart Learning**.

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Collect Room Data** | On | Takes a reading of every room every 5 minutes. Turn it off to stop recording; readings already stored stay until they age out. |
| **Keep Room Data For** | 60 days | Readings older than this are deleted. 30 to 365 days. |

## What a reading holds

One row per room, every 5 minutes, whether or not the equipment is running:

- the room's temperature (the mean of its sensors that have reported recently; stale sensors are left out, the same way the engine leaves them out)
- the zone thermostat's temperature and what the equipment is doing (heating, cooling, idle), and whether auxiliary heat is on
- the outside temperature, when an outside sensor is set in Settings → Sensors
- how much of the room's vents, and of the whole zone's vents, are open
- whether the room is occupied, and whether one of its doors or windows is open

Anything HomeClimate can't know at that moment (a room with no sensors, an occupancy sensor that is offline) is stored as unknown rather than guessed. All temperatures are stored in °F.

## Data Collected

The section lists each room with how many days of readings it has. Learning needs about two weeks from a room before it can model it. A room whose sensors were missing from more than a fifth of its readings is flagged, because a model fitted to gaps is a poor one; check that room's temperature sensors in My Home.

## API

- `GET /api/learning` returns the settings, the total number of readings, and per-room progress.
- `PUT /api/learning/settings` changes `sampling_enabled` and `sample_retention_days`.

Both are also MCP tools. Readings live in the `room_samples` table.
