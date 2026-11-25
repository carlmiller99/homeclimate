# Changelog

## 0.5.8

- Settings → Notifications: send the warnings and errors you choose, and an optional daily summary, to your phone through a Home Assistant notify service. Off until you turn it on. Each message is sent once, with a limit of six warnings and six errors an hour. See docs/notifications.md.
- Smart Control → Smart Learning → Start Rooms Early: start a room ahead of its next schedule block by as long as its model says it takes, so it is ready on time. Off by default; Watch Only logs what it would do. See docs/smart-learning.md.
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
