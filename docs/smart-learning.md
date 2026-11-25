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
- whether the room is occupied, whether one of its doors or windows is open, and whether a fireplace that warms it is lit or cooling down

Anything HomeClimate can't know at that moment is stored as unknown rather than guessed: a room with no sensors, a vent or occupancy sensor that is offline, a room with no door sensor or one that isn't reporting. Nothing is recorded while Home Assistant is disconnected, so an outage shows as a gap.

## Storage

Readings are stored compactly: temperatures as hundredths of a °F, vent openness as thousandths, times as whole seconds, and room and thermostat names as small numbers looked up in a second table. Twenty rooms kept for 60 days take about 12 MB. The space levels off once the oldest readings start ageing out.

## Data Collected

The section lists each room with how many days of readings it has and when the last reading was taken. A room that had no temperature in more than a fifth of its readings is flagged; check that room's temperature sensors in My Home.

## API

- `GET /api/learning` returns the settings, the total number of readings, and per-room progress.
- `PUT /api/learning/settings` changes `sampling_enabled` and `sample_retention_days`.

Both are also MCP tools. Readings live in the `room_readings` table, with `room_reading_keys` holding the names.

## What each room has taught

Each night at 3:20 AM (house time) HomeClimate fits a small model to each room's last 30 days of readings. **Work It Out Now** in the section does the same on request. Nothing is controlled from it yet; coasting, start times and suggestions will read it.

The readings are grouped into half-hours, and for each one the model explains how fast the room's temperature moved:

| Term | What it is | Starting value |
| --- | --- | --- |
| Heat loss | Drift toward the outside temperature, per degree of difference | 1 °F an hour per 30 °F |
| Zone pull | Drift toward the thermostat's reading, from air mixing with the rest of the zone | 0.1 °F an hour per °F |
| Heating rate | How fast the room warms while the zone heats, scaled by how far its vent is open | 3 °F an hour |
| Cooling rate | The same for cooling | 3 °F an hour |
| Everything else | People, appliances, sun | 0 |

A term the readings can't speak to keeps its starting value and is shown as not learned yet:

- The **heating rate** needs about 3 hours of half-hours in which heating ran at least three quarters of the time; the **cooling rate** the same for cooling. A room held steady by short bursts shows how loss and heating balance but not how fast either is, so it does not count however long it goes on. Morning recoveries from a night setback are what teach it.
- **Heat loss** needs the difference between inside and outside to have varied (a standard deviation of at least 3 °F).
- A fitted value that makes no physical sense (heating that cools, walls that gain heat from the cold) is held at its starting value, the other terms are fitted again around it, and it is shown as not learned.

Half-hours are left out when a door or window was open, a fireplace was lit or cooling down, auxiliary heat ran, a reading was missing, the room changed zone, the thermostat reported something other than heating, preheating, cooling, idle, off or fan (defrosting, for example), or the temperature jumped more than a room can (a sensor glitch). A thermostat that does not report what it is doing at all gives the model nothing to use.

**Grades**: *Not enough yet* (under a day of usable half-hours), *Learning*, and *Ready* (six days of usable half-hours, heat loss learned, and the heating or cooling rate learned).

Limits worth knowing:

- Sun through windows is not modelled yet; it is part of "everything else".
- A sensor that reports in whole degrees, or that lags the room by several minutes, makes the rates come out low.
- The model is fitted from snapshots every five minutes, so heating that runs in bursts shorter than that is under-counted.

The fit takes well under a second per room, and stores one row per room (`room_models`).

### API

- `GET /api/learning` includes each room's `model` (or null before the first fit).
- `POST /api/learning/fit` fits every room now, and answers 500 if it could not.

