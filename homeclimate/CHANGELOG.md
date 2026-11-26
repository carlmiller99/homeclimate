# Changelog

## 0.5.18

- Warnings look the same on every page: a quiet row saying what and why, the particulars folded under Details, and a link to where it is fixed. The orange and yellow Dashboard banners are gone.
- Dashboard: each building is one card, with its own targets in its header and a **Hold a Room** button. The targets card above the buildings is gone: targets belong to a building, and a zone's own targets are folded under it.
- Dashboard: a room's row shows its name and one temperature, and the whole row opens the room's details: its targets, a hold, what it follows, occupancy, vents and each sensor's reading. The Hold, Options and Clear Presence buttons that sat on every row are in there.
- My Home: **Edit Zone** opens one dialog with two tabs, Equipment and Thermostat, in place of two cards.
- My Home: each device box on a room's card opens a dialog for that kind of device in that room. The separate room device page and its Edit Devices button are gone.
- My Home: **Shades** are a fifth kind of room device, added and changed from the room. Smart Control → Shades keeps how shades react to the sun, with a status list.
- Smart Control → **Schedules**: each room's card now also asks whether the room is in use: Always, When a Calendar Says So, or Never. The separate Rooms In Use by Calendar card is gone.
- Colours: text and backgrounds are a little closer together in both the light and the dark theme.
- Smart Control → **Auto Mode** (was "One Side Per Building", under Forecasts): its own section, in plain words. For each building: whether in Auto it lets each zone decide or heats and cools as one, how often it may switch between heating and cooling, and how far past its target a room must be first.

## 0.5.17

- Dashboard: **Targets** replace the house band. Each building has a heating target and a cooling target, and a zone or a room can be given its own; anything without its own follows the level above, and the Dashboard says which. The two targets can be the same number, so a home can be held at 71, or between 71 and 72, all year: the 3 °F minimum between them is gone, here and on a schedule's, a hold's and an occupancy target's Cool To.
- Upgrading: the house band you had becomes the targets of every building, and of every zone that is in no building, so every room is kept where it was.
- Targets are checked against the safety limits of the zones they reach, so one building's limits no longer restrict another's targets. A zone that leaves its building, or whose building is deleted, keeps the targets it was following.
- Smart Control → Forecasts: each building's Auto now has **Auto May Change Sides** (several times a day, once a day, once a week or once a month, each counted from the last change) and a **Switching Threshold** (3 °F unless changed): how far past its target on the other side a room must be before the building considers changing sides. Each choice is explained on the page.
- The limit always holds. A room far from its target no longer changes a building's side early; to change sooner, set the building to Heat Only or Cool Only. Safety limits still act at once.
- On a weekly or monthly limit, a change also waits until the forecast for the next three days favours the other side.
- Smart Control → **Fan** (new, off until turned on per zone): while a building holds a zone to heating or to cooling, HomeClimate can run the fan alone to mix a room that is past its target on the other side with a room that is closer to it. No more than 30 minutes in any hour, not for 15 minutes after a run, never for a room paused by a door or window, and Watch Only logs what it would have done. See `docs/fan.md`.
- My Home → Edit Zone: **Outside Air Intake** (Yes, No, Not Sure). With an intake, the fan only runs alone while outside air would help. **Test** runs the fan for 10 minutes and reports whether the rooms moved toward the outside temperature: a hint, not an answer.
- API: `PUT /api/house/targets/{scope}/{scope_id}` replaces `PUT /api/house`, and `GET /api/house` lists the targets set at each level. `PUT /api/building-modes/{building_id}` takes `switching` and `switch_threshold`.

## 0.5.16

- Room devices: each search now lists only the right kind of device (temperature sensors, vents, door and window sensors, occupancy sensors), and leads with the ones in the Home Assistant area named like the room.
- My Home: a zone can be empty. Add Zone no longer asks for a first room, a zone's last room can be deleted or moved, and an empty zone says it cannot be controlled until a room is added, with an Add Room button there.
- My Home: Delete Zone is in each zone's header. Deleting a building now keeps its zones and rooms and moves them to Unassigned, after a confirmation, where it used to be refused.
- My Home: a zone's title is a plain heading over its room cards, not a card itself.
- My Home: only Add Building is at the top of the page. Add Zone is inside each building and Add Room inside each zone, so a new zone or room goes where its button is.
- Add Zone now asks what kind of system the zone is (conventional or heat pump) and what its heat is, and no longer assumes conventional with electric strips. When Home Assistant shows the signs of a heat pump the form suggests it, and a zone left as conventional whose thermostat looks like a heat pump is marked in My Home; the mark opens Edit Zone.
- Set Up from Home Assistant sets a new zone up as a heat pump when Home Assistant shows the signs of one, and says what it did when it finishes. When two thermostats share a name it tells them apart by their entity ids.
- A conventional zone's heat is now called Electric Strips, Gas Furnace or None in its summary and under Edit Zone.
- Room devices: a room that has just been added shows what to add first. After that, each kind of device it still lacks gets one plain line saying what the room cannot do without it, in place of the orange and blue warnings.
- The dot beside anything that is off (System, the MCP server, the MQTT bridge) is now gray instead of red.

## 0.5.15

- Dashboard: Vacation Mode is now at the top of the page beside the System switch, drawn the same way, and reads Off, Scheduled or On. It opens the same dialog as before.
- Settings → Sensors: you can now choose several outside temperature sensors. HomeClimate uses their average wherever it needs the outside temperature, and leaves out one that stops answering until it comes back. One sensor works as before.

## 0.5.14

The first release from `main` since 0.5.0. It carries everything listed below under 0.5.2 to 0.5.13, which until now was only in test builds.

- Analytics: chart axis labels keep the theme's colour in dark mode after the charting library update.
- Dependency updates (recharts 3.11, react-router 8.5.2 and development tooling).

## 0.5.8 to 0.5.13 (test builds)

- Dashboard → Today's Plan: the next 24 forecast hours marked as heating, coasting or cooling against the house band, the next schedule blocks and peak hours on the clock, and yesterday in a sentence. It shows; it changes nothing.
- Smart Learning: rooms with a window of known direction (a shade in My Home) now learn how much the sun warms them, and that is used wherever a room is predicted to drift by itself. The sun's position and strength are adapted from RoomMind (MIT; see THIRD_PARTY_NOTICES.md).
- Smart Control → Doors & Windows → Shades → Close Ahead of a Warm Room: a sunlit shade closes before any cooling runs when it is warmer outside and the room is close to, or expected to pass, the top of what it is asked to hold. Off until you turn it on. See docs/shades.md.
- Smart Control → Smart Learning → Early Cooling: on a day still warming, a banded room whose model says it will pass its Cool To within three hours is cooled a little now instead. Never a hold, never outside the band, and it gives way to any room that asks for itself. Off until you turn it on; Watch Only logs what it would do. See docs/smart-learning.md.
- Smart Control → Smart Learning → Get Rooms Ready for Usual Arrivals: a room is brought to its occupied temperature shortly before the hours of the week it is usually used, from its own occupancy history. It gives way to any room that asks for itself and is let go if nobody arrives. Off until you turn it on; Watch Only logs what it would do. See docs/smart-learning.md.
- Smart Control → Peak Hours: bank heat or cool ahead of the hours when electricity costs most. Rooms following a band are worked a set depth into it before the peak, never past the band, only when the forecast for those hours calls for it, and never a hold. Off until you turn it on. See docs/peak-hours.md.
- Smart Control → Smart Learning → Suggestions: advice from 14 days or more of history. A wider deadband for a zone with many short runs, and the hours a room is usually occupied as the blocks a schedule for it might have. Advice only; nothing is changed. See docs/smart-learning.md.
- Smart Control → Zone Balance: per building, keep zones within a gap limit of each other (3 °F to start with). A zone too far behind one that is in use is heated or cooled back to the limit, only in the direction the building is already working. Off by default; Watch Only logs what it would do. See docs/zone-balance.md.
- Smart Control → Smart Learning → Let Rooms Coast: a call waits when the room is a little short of its target and its model and the forecast say it will drift there on its own, up to 45 minutes (three times that on electric strip heat), never once it is 2 °F off, and never for a hold. Off by default; Watch Only logs what it would do. Three bad waits in a week switch it back to Watch Only. See docs/smart-learning.md.
- Settings → Notifications: send the warnings and errors you choose, and an optional daily summary, to your phone through a Home Assistant notify service. Off until you turn it on. Each message is sent once, with a limit of six warnings and six errors an hour. See docs/notifications.md.
- Smart Control → Smart Learning → Start Rooms Early: start a room ahead of its next schedule block by as long as its model says it takes, so it is ready on time. Off by default; Watch Only logs what it would do. See docs/smart-learning.md.
- Heat pumps: an early warm-up, once started, is kept until its block begins, so a room that warms faster than the recovery rate no longer drops out and comes back.
- Smart Learning now works out, each night, how fast each room heats, cools and drifts toward the outside temperature, from its recorded readings. Smart Control → Smart Learning shows what each room has taught and how ready it is. Nothing is controlled from it yet. See docs/smart-learning.md.

## 0.5.7

- Smart Control → Forecasts now shows how far off the forecast has been against your outside sensor, and after two days of comparisons corrects it for each hour of the day. On by default; **Correct the Forecast From Experience** turns it off. See docs/forecasts.md.
- A schedule block, a hold and a room's occupancy target can each be a band: add a Cool To and the target becomes its Heat To, with the room kept between the two. Leave Cool To blank and nothing changes. See docs/house-band.md.

## 0.5.6

- Dashboard: each building has a mode, Auto, Heat Only, Cool Only or Off, with a line saying what the building is doing and which zones are waiting. Safety limits still act in every mode.
- Smart Control → Forecasts → One Side Per Building: Auto can keep every zone in a building heating or cooling together, switching sides only after the running cycle ends, a 10-minute wait, 4 hours since the last switch, no more than twice a day, and a forecast that does not rule it out. A room 2 °F past where it would start switches it sooner. Off by default; Watch Only logs what it would do without holding anything. See docs/building-mode.md.
- Eco Mode's zone settings moved from the thermostat settings in My Home to Smart Control → Eco Mode, with their own Save. Nothing about how Eco works has changed. A room's own Eco settings are still in its room settings.

## 0.5.5

- Smart Control → Schedules → Rooms In Use by Calendar: a room's In Use can follow a Home Assistant calendar. It is in use while an event is on and from a set time before one starts; the rest of the time it asks for nothing. A calendar that stops answering changes nothing for 30 minutes, then the room is treated as in use. See docs/house-band.md.
- Vacation Mode no longer commands cooling for a zone that a lit fireplace is warming.

## 0.5.4

- Dashboard: a System On / Off switch at the top right (it was only in the gear menu).
- The Metrics tab is now called Analytics.
- The add-on logo no longer carries a subtitle.
- Dashboard → House: set one Heat To and Cool To for the whole house. Every room in use is kept between them unless a hold, a schedule or occupancy gives it its own target. Off until you set it; nothing changes until then. See docs/house-band.md.
- Dashboard → Options on each room: mark a room Not In Use (it asks for nothing but a hold; safety limits still apply), or switch off its schedules or occupancy so it follows the house band instead. Schedules are skipped, not deleted.

## 0.5.3

- Smart Control → Fireplace: add a fireplace with the entity that is on while it burns and every room it warms. On Watch Only it is tracked and logged; set to On, its rooms stop calling for heating or cooling while it is lit and through a cool-down, and the Dashboard marks them. HomeClimate never switches a fireplace. See docs/fireplace.md.
- Smart Control → Forecasts: choose a weather source and HomeClimate fetches the hourly forecast every 30 minutes, keeps the last good one through outages, and archives it. The forecast is shown but does not yet change control. See docs/forecasts.md.
- Smart Learning readings take about an eighth of the space (roughly 12 MB for 20 rooms over 60 days). Readings from 0.5.2 are moved over at start-up.
- Readings now record how far open each vent is rather than open or closed, count the thermostat's own reading for rooms that include it, and store offline vents and door sensors as unknown. Nothing is recorded while Home Assistant is disconnected.
- Shortening Keep Room Data For asks first, because it deletes readings. The section shows when the last reading was taken.

## 0.5.2

- Smart Control → Smart Learning: HomeClimate records a reading of every room every 5 minutes (temperature, vents, occupancy, open doors and windows, equipment state, outside temperature). Recording changes nothing about how the home is controlled. Collect Room Data turns it off, Keep Room Data For sets how long readings are kept (60 days by default), and the section shows how much each room has collected. See docs/smart-learning.md.

## 0.5.0

- First HomeClimate release.
- Set Up from Home Assistant: import zones from thermostats and rooms from areas, with names, buildings and combined areas reviewed before anything is created.
- Smart Control: pause a zone or a single room while a door or window stays open, with house-wide defaults and per-zone and per-room overrides.
- Heat pump support: zones marked as heat pumps get a capped, rate-limited heating setpoint, runtime and heating airflow floors, a wait between heating and cooling, and backup heat episode logging.
- One rule for where things live: Dashboard shows status and manual control, My Home edits structure and hardware, Smart Control tunes what runs on its own. See docs/navigation.md.
- My Home replaces the Rooms, Zones and Thermostats tabs. Every room belongs to a zone and every zone has one thermostat and at least one room; a zone's last room can't be deleted or moved, and Add Zone creates a zone with its first room. Thermostat settings sit inside their zone.
- Room cards list hardware in four sections (Smart Vents, Temperature Sensors, Doors & Windows, Occupancy Sensors). Doors and windows are added to a room in Edit Devices and pause either that room or its whole zone. Delete Room moved into Room Settings.
- Dashboard groups zones by building and lists every room with its temperature. Hold, Cancel Hold and Clear Presence are on each room; the Schedules page shows a held room's hold but no longer changes it.
- Schedules is a section of Smart Control, next to Doors & Windows (which now holds Shades).
- Settings has a side menu: General, Sensors, Integrations, Logs and Dev Mode. The Dev Mode switch moved there from the gear menu, and turning Dev Mode off asks first. Old page links redirect.
- Smart Control: shades open in the sun while a zone heats and close while it cools, with occupancy, quiet hours, manual-move hold and cloud cover rules.
- Heat pumps: a When to Use Auxiliary Heat setting (Avoid or Allow When Needed), early warm-ups, a back-off after auxiliary heat runs, a defrost allowance on cycle timeouts, a Strips Expected state below the compressor lockout, and auxiliary heat minutes in Metrics.
