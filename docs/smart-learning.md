# Smart Learning

Smart Learning is where HomeClimate learns how each room heats and cools so it can plan ahead. The first part is in place: a recorder that takes a reading of every room every 5 minutes. Recording commands nothing. It does not move a vent or change a thermostat.

Find it under **Smart Control → Smart Learning**.

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Collect Room Data** | On | Takes a reading of every room every 5 minutes. Turn it off to stop recording; readings already stored stay until they age out. |
| **Keep Room Data For** | 60 days | Readings older than this are deleted, checked every 5 minutes. 30 to 365 days. Shortening it deletes readings for good, so the page asks first. |

## What a reading holds

One row per room, on the 5-minute marks, whether or not the equipment is running:

- the room's temperature: the mean of its sensors that have reported recently, plus the thermostat's own reading for rooms set to include it. Stale sensors are left out.
- the zone thermostat's temperature and what it reports the equipment is doing (heating, cooling, idle), and whether auxiliary heat is on
- the outside temperature, when an outside sensor is set in Settings → Sensors
- how far open the room's vents are, and the whole zone's vents, from 0 to 1. Position and tilt vents report their position; others count as fully open or closed.
- whether the room is occupied, and whether one of its doors or windows is open

Anything HomeClimate can't know at that moment is stored as unknown rather than guessed: a room with no sensors, a vent or occupancy sensor that is offline, a room with no door sensor or one that isn't reporting. Nothing is recorded while Home Assistant is disconnected, so an outage shows as a gap.

## Storage

Readings are stored compactly: temperatures as hundredths of a °F, vent openness as thousandths, times as whole seconds, and room and thermostat names as small numbers looked up in a second table. Twenty rooms kept for 60 days take about 12 MB. The space levels off once the oldest readings start ageing out.

## Data Collected

The section lists each room with how many days of readings it has and when the last reading was taken. A room that had no temperature in more than a fifth of its readings is flagged; check that room's temperature sensors in My Home.

## API

- `GET /api/learning` returns the settings, the total number of readings, and per-room progress.
- `PUT /api/learning/settings` changes `sampling_enabled` and `sample_retention_days`.

Both are also MCP tools. Readings live in the `room_readings` table, with `room_reading_keys` holding the names.
