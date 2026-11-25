# HomeClimate documentation

High-level guide to what HomeClimate does and how the pieces fit together. For install instructions and quick-start, see the [top-level README](../README.md).

## Feature guides

- [Where things live](./navigation.md) — the five tabs, the rule that decides what goes where, and where each setting is
- [Rooms & zones](./rooms-and-zones.md) — how rooms map to thermostats and what gets configured per room
- [Cycle engine](./cycle-engine.md) — the HVAC cycle state machine: what runs every 60s tick
- [Overflow conditioning](./overflow-conditioning.md) — where surplus air goes during the minimum-runtime hold
- [Vent control methods](./vent-control.md) — the four ways HomeClimate can drive a `cover.*` entity
- [Thermostat settings](./thermostat-settings.md) — setpoint bounds, deadband and the room/schedule overrides that inherit from it, overshoot, timeouts, safety limits
- [Heat pumps](./heat-pumps.md) — heat pump protection guards and backup heat logging
- [Safety features](./safety.md) — short-cycle protection, outdoor-temperature cooling lockout, equipment-protection limits
- [Schedules](./schedules.md) — time blocks, overnight ranges, priority rules, per-block deadband override
- [Presence & motion](./presence.md) — motion-triggered activation and holdover
- [Doors & windows](./doors-and-windows.md) — pause a zone or a room while a door or window is open (Smart Control)
- [Shades](./shades.md) — open sunlit shades when heating and close them when cooling (Smart Control)
- [Smart Learning](./smart-learning.md) — the room data recorder that learning is built on (Smart Control)
- [Forecasts](./forecasts.md) — fetch, keep and archive the hourly weather forecast (Smart Control)
- [House band](./house-band.md) — one heat-to and cool-to for the whole house, and per-room options for what each room follows (Dashboard)
- [Fireplace](./fireplace.md) — keep rooms a fire is warming out of the heating and cooling's way (Smart Control)
- [Temperature holds](./temperature-holds.md) — hold one room at an exact temperature for 1–8 hours, overriding schedules and presence
- [Pre-cool / pre-heat](./precool-presence.md) — let a room coast to target on outside air instead of running HVAC for presence
- [Eco Mode](./eco-mode.md) — outdoor-temperature-compensated setpoint drift (relax targets when it's extreme outside)
- [System modes](./system-modes.md) — the System On/Off toggle and Dev Mode
- [Vacation mode](./vacation-mode.md) — pausing the house for a trip, starting it now or scheduling it ahead, the two hold strategies, per-room safety cycles while you are away, and welcome home before you return
- [Observability](./observability.md) — dashboard, event logs, cycle history, WebSocket
- [Metrics & analytics](./metrics.md) — `/metrics` page charts, outside-temperature correlation, CSV export, live HA sensor endpoint
- [Time zones](./time-zones.md) — every time is shown and entered in the house's zone; DST rules; the API's unchanged input semantics
- [Backup & restore](./backup-restore.md) — download/upload the SQLite database
- [Authentication & the trust model](./auth.md) — ingress trust, login on the direct ports, MCP bearer tokens, OIDC single sign-on
- [MCP server](./mcp.md) — Claude-callable tools over the add-on
- [MQTT interface](./mqtt.md) — drive HomeClimate from Home Assistant automations, with controls exposed as native HA entities
- **API Documentation** — Interactive Swagger UI available at `/api/docs`

## Conventions

- All temperatures are stored and displayed in **°F**. Sensors reporting °C are converted on ingest.
- All times are evaluated **and shown** in the timezone configured in the add-on's **Configuration** tab (see the [top-level README](../README.md#timezone-configuration)), never the viewing device's zone. See [Time zones](./time-zones.md).
- Entity IDs follow Home Assistant's `domain.object_id` format. HomeClimate only drives `cover.*` (vents), `climate.*` (thermostats), reads from `sensor.*` (temperature), and `binary_sensor.*` (presence).
