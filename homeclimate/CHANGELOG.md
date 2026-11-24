# Changelog

## 0.5.0

- First HomeClimate release.
- Set Up from Home Assistant: import zones from thermostats and rooms from areas, with names, buildings and combined areas reviewed before anything is created.
- Smart Control: pause a zone or a single room while a door or window stays open, with house-wide defaults and per-zone and per-room overrides.
- Heat pump support: zones marked as heat pumps get a capped, rate-limited heating setpoint, runtime and heating airflow floors, a wait between heating and cooling, and backup heat episode logging.
- Smart Control: shades open in the sun while a zone heats and close while it cools, with occupancy, quiet hours, manual-move hold and cloud cover rules.
- Heat pumps: a When to Use Auxiliary Heat setting (Avoid or Allow When Needed), early warm-ups, a back-off after auxiliary heat runs, a defrost allowance on cycle timeouts, a Strips Expected state below the compressor lockout, and auxiliary heat minutes in Metrics.
