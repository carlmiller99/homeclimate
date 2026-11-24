# Changelog

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
