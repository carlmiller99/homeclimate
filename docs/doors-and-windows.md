# Doors & windows

Smart Control can stop conditioning air that is going straight outside. Attach a door or window sensor (any `binary_sensor.*` that reads `on` when open) to a whole zone, or to one room, from **Smart Control → Sensors**, or bring them in with **Set Up from Home Assistant**.

## What pauses

| Sensor attached to | Setting | What happens |
|---|---|---|
| A zone | Pause Zone When a Door or Window Is Open For (default on, 3 min) | Every room on that thermostat stops calling. A running cycle ends with the reason "door or window open" and the thermostat parks. |
| A room | Pause Room When a Door or Window Is Open For (default on, 5 min) | That room leaves the cycle and its vents close. Other rooms keep running. |

A pause ends once every sensor it watches has been closed for **Resume After Everything Is Closed For** (default 2 min). Turning a rule off releases its pause at once.

Safety protection still applies while paused: a room that breaches its safety limits is still conditioned, so an open window in winter cannot freeze the house.

## Rules for the timer

- Only a **closed → open** change starts the timer. A sensor that is already open when HomeClimate starts, or that comes back open after being offline, pauses nothing until it closes and opens again.
- A sensor that goes **offline** (`unavailable` or `unknown`) counts as closed, so it releases its pause after the resume delay.
- Timers live in memory. Restarting HomeClimate releases every pause.

## Overrides

Each zone and each room can override the house-wide values. In **Smart Control → Sensors**, select the link on a zone's header to edit the zone and its rooms. A room's resume delay falls back to its zone's override before the house-wide value. **Use Defaults** clears an override.

## Storage

| Where | What |
|---|---|
| `system_settings` | `openings_zone_pause_enabled`, `openings_zone_pause_min`, `openings_room_pause_enabled`, `openings_room_pause_min`, `openings_resume_min` |
| `contact_sensors` | One row per sensor, with either `thermostat_entity_id` or `room_id`. Deleting the zone or room removes the row. |
| `smart_control_overrides` | `(scope, scope_id, key, value)` per-zone and per-room overrides |

## API

- `GET /api/smart-control`: settings, overrides, sensors with live state, and current pauses
- `PUT /api/smart-control/settings`
- `PUT /api/smart-control/overrides/{zone|room}/{id}`: `null` clears a key
- `PUT /api/smart-control/contacts/{entity_id}` with `thermostat_entity_id` or `room_id`
- `DELETE /api/smart-control/contacts/{entity_id}`

Pause and resume events appear in **Logs** under the `openings` category.
