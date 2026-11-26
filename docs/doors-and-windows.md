# Doors & windows

Smart Control can stop conditioning air that is going straight outside. Add a door or window sensor (any `binary_sensor.*` that reads `on` when open) to its room in **My Home → the room's Doors & Windows box**, and choose whether it pauses **This Room** or the **Whole Zone**. **Set Up from Home Assistant** can bring them in too. The timing below is set in **Smart Control → Doors & Windows**.

## What pauses

| Sensor pauses | Setting | What happens |
|---|---|---|
| Whole Zone | Pause Zone When a Door or Window Is Open For (default on, 3 min) | Every room on that thermostat stops calling. A running cycle ends with the reason "door or window open" and the thermostat parks. |
| This Room | Pause Room When a Door or Window Is Open For (default on, 5 min) | That room leaves the cycle and its vents close. Other rooms keep running. |

A pause ends once every sensor it watches has been closed for **Resume After Everything Is Closed For** (default 2 min). Turning a rule off releases its pause at once.

Safety protection still applies while paused: a room that breaches its safety limits is still conditioned, so an open window in winter cannot freeze the house.

The Dashboard shows a paused zone or room, and names the open door or window.

## Rules for the timer

- Only a **closed → open** change starts the timer. A sensor that is already open when HomeClimate starts, or that comes back open after being offline, pauses nothing until it closes and opens again.
- A sensor that goes **offline** (`unavailable` or `unknown`) counts as closed, so it releases its pause after the resume delay.
- Timers live in memory. Restarting HomeClimate releases every pause.

## Overrides

Each zone and each room can override the house-wide values. In **Smart Control → Doors & Windows**, under Overrides, select the link on a zone's row to edit the zone and its rooms. A room's resume delay falls back to its zone's override before the house-wide value. **Use Defaults** clears an override.

## Storage

| Where | What |
|---|---|
| `system_settings` | `openings_zone_pause_enabled`, `openings_zone_pause_min`, `openings_room_pause_enabled`, `openings_room_pause_min`, `openings_resume_min` |
| `contact_sensors` | One row per sensor, with its `room_id` and `pauses` (`room` or `zone`). Deleting the room removes the row. A sensor that was attached straight to a zone, from before sensors belonged to rooms, is moved into that zone's first room at start-up and keeps pausing the whole zone. |
| `smart_control_overrides` | `(scope, scope_id, key, value)` per-zone and per-room overrides |

## API

- `GET /api/smart-control`: settings, overrides, sensors with live state, and current pauses
- `PUT /api/smart-control/settings`
- `PUT /api/smart-control/overrides/{zone|room}/{id}`: `null` clears a key
- `PUT /api/smart-control/contacts/{entity_id}` with `room_id` and `pauses` (`room` or `zone`)
- `DELETE /api/smart-control/contacts/{entity_id}`

Pause and resume events appear in **Settings → Logs** under the `openings` category.
