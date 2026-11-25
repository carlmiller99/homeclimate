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

## Start Rooms Early

**Smart Control → Smart Learning → Start Rooms Early** uses the model to have a room at its next schedule block's target when the block begins, instead of starting from cold at that moment.

- **Off** (the default), **Watch Only** (logs what it would do and starts nothing) or **On**.
- How early is the time the room's model says it needs in the current weather, never less than 15 minutes and never more than 3 hours.
- Only for a rate the room has taught (see the grades above), and only from a model fitted within the last week. It needs an outside temperature reading, and the room has to be in use with its schedules switched on.
- The weather and the thermostat have to agree with the direction: heating early only when it is colder outside than the target, cooling early only when it is warmer, and never heating on a thermostat set to cool or cooling on one set to heat. So a night setback is never "prepared for" by running the other equipment.
- A room with nothing scheduled right now can be started early. So can a room that is in a block already, when the next block asks for more of the same: warmer when heating (62 °F overnight, then 70 °F at 7:00), cooler when cooling. A hold, presence, or a block with a band is left alone.
- Once a room is started early it stays started until its block begins, even if it warms faster than expected, so the equipment is not switched off and on again on the way. The run ends when the room reaches the target, by the same rules as any other run. If it gets there early, it is kept at that target until the block begins.
- Never against the side its building is on.
- A cool-down is not started early toward a block with a band, because the block's target there is its Heat To.
- The coming block's own deadband is used, if it has one.
- Heat pump zones keep their own early warm-up and their capped climb; this can start them earlier, not faster. It does not start heating early while auxiliary heat is expected.
- A room that is paused for an open door or window, or set aside for the fireplace, is not started. Nothing is started early in Vacation Mode.

Each early start is logged once under Engine.

## Let Rooms Coast

**Smart Control → Smart Learning → Let Rooms Coast** lets a call wait when the room is only a little short of its target and will drift there by itself soon: a room at 68.4 °F asked for 70 °F on a morning that is already 80 °F outside does not need the equipment started for it.

- **Off** (the default), **Watch Only** (logs what it would do and holds nothing back) or **On**.
- Whether a room will get there comes from its own model and the forecast for the next hour or two, shifted to agree with the outside sensor now. It needs a model fitted within the last week that has learned the room's heat loss, and an outside reading.
- Only a schedule or presence call with a single target waits. A hold never waits. Neither does a room following a band, or one being started early for a coming block.
- Only while nothing is running in the zone. If the equipment starts for another room, a waiting room is served with it.
- A room 2 °F or more from its target is never kept waiting.
- A wait lasts 45 minutes at most. Where heating is electric strip heat (a conventional zone with electric heat, or a heat pump below its compressor lockout) it is three times that, because a start avoided there saves the most.
- A call gets one wait. If the room has not arrived when it ends, or the model stops expecting it to, the equipment starts as usual. A wait is not begun if the model expects the room to slip 1.5 °F from its target on the way. After a wait, the same room does not wait again for half an hour.
- A wait ends without counting if the equipment starts for another room, the setting changes, or the outside reading is lost. A wait left over from before Vacation Mode or the system being switched off is forgotten.
- Changing the room's target starts a new call, and so does a restart of HomeClimate; either can begin a new wait.
- A wait that ends with the room 1.5 °F or more from its target is a miss. Three in a week switch the setting back to Watch Only, with a warning in the log (which Notifications can send). The section shows how many there have been this week, and says when it has switched itself back.
- Safety protection is never delayed. Paused rooms, the fireplace, Vacation Mode and Eco Mode work as before.

A waiting room shows **Coasting** on the Dashboard. Each wait is logged under Engine when it begins and when it ends: reached by coasting, or not.

The limits are 2 °F and 1.5 °F (1.1 °C and 0.8 °C). A zone whose equipment has not been set in My Home counts as electric strip heat, which is the default; set a gas furnace there to get the shorter wait.

### API

- `GET /api/learning` includes each room's `model` (or null before the first fit).
- `POST /api/learning/fit` fits every room now, and answers 500 if it could not.

