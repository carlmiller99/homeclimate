# Changelog

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
