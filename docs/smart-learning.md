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
| Sun | How fast full sun on the room's windows warms it (rooms with a window of known direction only) | 0 |
| Everything else | People, appliances | 0 |

A term the readings can't speak to keeps its starting value and is shown as not learned yet:

- The **heating rate** needs about 3 hours of half-hours in which heating ran at least three quarters of the time; the **cooling rate** the same for cooling. A room held steady by short bursts shows how loss and heating balance but not how fast either is, so it does not count however long it goes on. Morning recoveries from a night setback are what teach it.
- The **sun** term needs about 10 hours of half-hours with sun on the room's windows. A room's windows are its shades in My Home (their Window Faces direction), whether or not the shades are automated; a room with none has no sun term. The sun's position comes from the house's location, read from Home Assistant's home zone at each fit.
- **Heat loss** needs the difference between inside and outside to have varied (a standard deviation of at least 3 °F).
- A fitted value that makes no physical sense (heating that cools, walls that gain heat from the cold) is held at its starting value, the other terms are fitted again around it, and it is shown as not learned.

Half-hours are left out when a door or window was open, a fireplace was lit or cooling down, auxiliary heat ran, a reading was missing, the room changed zone, the thermostat reported something other than heating, preheating, cooling, idle, off or fan (defrosting, for example), or the temperature jumped more than a room can (a sensor glitch). A thermostat that does not report what it is doing at all gives the model nothing to use.

**Grades**: *Not enough yet* (under a day of usable half-hours), *Learning*, and *Ready* (six days of usable half-hours, heat loss learned, and the heating or cooling rate learned).

Limits worth knowing:

- The sun term is the clear-sky sun on the windows. Cloud cover, and whether a shade was down, are not recorded, so what is learned is the room's usual gain on days like those it has seen. It is used wherever the model predicts: where a room is expected to drift by itself (Let Rooms Coast, Early Cooling, shades closing ahead of a warm room) and in how long a warm-up or cool-down will take (Start Rooms Early, Get Rooms Ready for Usual Arrivals). The Smart Learning summary shows the gain with the sun full on the windows, which is about four tenths of the fitted figure.
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
- Changing the room's target starts a new call, which can wait in its turn once half an hour has passed since the last wait. A restart of HomeClimate forgets the waits, so a room may wait again after one.
- With a deadband wider than 1.5 °F a room is already that far off when it calls, so it never waits.
- A wait that ends with the room 1.5 °F or more from its target is a miss. Three in a week switch the setting back to Watch Only, with a warning in the log (which Notifications can send). The section shows how many there have been this week, and says when it has switched itself back.
- Safety protection is never delayed. Paused rooms, the fireplace, Vacation Mode and Eco Mode work as before.

A waiting room shows **Coasting** on the Dashboard. Each wait is logged under Engine when it begins and when it ends: reached by coasting, or not.

The limits are 2 °F and 1.5 °F (1.1 °C and 0.8 °C). A zone whose equipment has not been set in My Home counts as electric strip heat, which is the default; set a gas furnace there to get the shorter wait.

## Get Rooms Ready for Usual Arrivals

**Smart Control → Smart Learning → Get Rooms Ready for Usual Arrivals** brings a room to its occupied temperature shortly before the time of week it is usually used, so it is comfortable when someone walks in rather than half an hour later.

| Level | What it does |
|---|---|
| **Off** (default) | Nothing. |
| **Watch Only** | Writes "Would get … ready" to the Engine log at the moment it would have started, and starts nothing. |
| **On** | Starts the room. |

How it decides:

- **Usual hours** come from the room's occupancy sensors: an hour of the week counts once the room has been occupied for most of it on at least two separate weeks, from two weeks or more of history. These are the same hours the schedule suggestion shows. They are read again every six hours.
- **An arrival** is the first of a run of usual hours. Monday 14:00 to 16:00 gives one arrival, at 14:00.
- **The lead** is 30 minutes until the room's model has learned how fast it warms or cools; after that it is the time the model says the room needs in this weather, never less than 15 minutes or more than 90.
- **The temperature** is the one occupancy would give the room: its own occupied temperature (or the top of its occupied band when it is too warm), else the zone's default. A room with neither is never started.

What it will not do:

- Take a room that has a hold, a schedule block or occupancy already, or a schedule for the arrival hour (Start Rooms Early covers that), or a room switched out of use or set not to follow occupancy.
- Go against the weather (heating toward a temperature it is already warmer than outdoors, or the reverse; with no outside sensor this check is skipped), against the thermostat's mode, against the side the building is held to, or onto a heat pump's strips.
- Get in the way. A room being got ready gives way to any room that asks for itself, exactly as Zone Balance and Peak Hours rooms do: the zone chooses its direction as if this were off, and a run that is only getting rooms ready ends for a room that calls the other way once it has had its minimum runtime.
- Keep going for nobody. Thirty minutes into the hour with nobody there, the room is no longer asked, and a run already going for it is wound up: once it has had its minimum runtime the run ends normally, wherever the room has got to. The same happens if you switch this off mid-run.
- Start a run the thermostat would refuse. If the thermostat's own reading is already past the temperature the room is being brought to, nothing is started.

The Dashboard marks such a room **Getting Ready**, and the cycle detail in Logs says "getting ready for a usual arrival".

Known limits: on the two days a year the clocks change, an arrival in the changed hour can be an hour out. A room that is got ready and then not used has run the equipment for nothing; Watch Only for a week or two shows how often that would happen before you turn it on.

## Early Cooling

**Smart Control → Smart Learning → Early Cooling** cools a room a little before a warm afternoon makes it necessary. A room following a band is normally left alone until it passes its Cool To, which on a hot day happens when the equipment is at its least efficient and every room wants it at once.

| Level | What it does |
|---|---|
| **Off** (default) | Nothing. |
| **Watch Only** | Writes "Would cool … early" to the Engine log when it would have started, and starts nothing. |
| **On** | Cools the room. |

A room is cooled early only when all of these hold:

- It follows a band (its targets, or a schedule or occupancy band), not a hold, and is inside it.
- The forecast for the next three hours is warmer than the room's Cool To and at least 3 °F (1.7 °C) warmer than now. A day that has already peaked is left alone.
- The room's own model, fitted in the last week with its heat loss learned, says the room would pass its Cool To within those three hours if nothing ran.
- The thermostat is not in heat mode and the building is not held to heating.

While those hold, its Cool To is in effect 1.5 °F (0.8 °C) lower: it is cooled to 1.5 °F (0.8 °C) below its Cool To, never closer than 1 °F and the room's deadband to its Heat To, and inside the zone's setpoint limits. Once it is there it is left until it drifts back past its deadband.

Like the other conveniences it gives way to any room that asks for itself, never sets or holds a building's side, starts nothing while a call in the zone is waiting to coast, and a room that has started a run stays in it until the run ends. Peak Hours and Zone Balance take a room first when they want it. The Dashboard marks such a room **Cooling Early**; the cycle detail in Logs says "early cooling". The Engine log says it once per room every three hours.

What to expect: cooling starts earlier, and the room is held slightly cooler through the warm-up, so this can use a little more cooling overall in exchange for doing it at a better time. Watch Only shows how often it would act before you decide.

## Suggestions

Below the section, **Suggestions** gives advice from what has been recorded. It changes nothing: each suggestion says what it rests on and where to make the change if you agree. Nothing is suggested until there are 14 days of history, and it looks back 30 days.

- **A wider deadband**, per zone. When a zone ran eight or more times a day and half of its runs were under 8 minutes, a deadband 0.5 °F (0.3 °C) wider is suggested, never past 2 °F (1.1 °C). Fewer, longer runs are easier on the equipment and hold rooms nearly as closely. Runs that were cut off (the thermostat away, a door opened, the system switched off) are not counted. A zone whose rooms all have a deadband of their own gets no such advice, since the zone's would change nothing; a minimum run time is the other way to lengthen runs.
- **When a room is usually in use**, per room with occupancy sensors. Each hour of the week in which the room was occupied at least 60 % of the time, and occupied in at least two separate weeks, joined into blocks with matching days grouped. These are the blocks a schedule for the room might have; add them under Schedules if they look right. They are not compared with the schedules the room already has. An evening that runs past midnight comes out as two blocks. Occupancy is read as the sensor stands every five minutes, so this works best with presence sensors that stay on while someone is there, not motion sensors that clear in seconds.

`GET /api/learning/suggestions` returns the same.

### API

- `GET /api/learning` includes each room's `model` (or null before the first fit).
- `POST /api/learning/fit` fits every room now, and answers 500 if it could not.

