# Shades

Smart Control can move shades so the sun helps: open when a zone is heating, closed when it is cooling. Add each shade in **Smart Control → Doors & Windows → Shades → Add Shade** with its room and the direction its window faces. A shade is a `cover` that is not one of the room's vents; a cover can't be both.

## When a shade moves

A window counts as **sunlit** when the sun is more than 5° above the horizon, within 80° of the window's direction, and the sky is less than 80% overcast (cloud cover comes from an optional `weather.*` entity).

| The zone is | Sunlit window | Otherwise |
|---|---|---|
| Heating | Opens | Left alone |
| Cooling | Closes | Left alone |
| Idle | Left alone | Left alone |

The zone's direction is its running cycle, or else the thermostat's own mode.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Automatically Control Shades to Optimize Solar Effects | off | Nothing moves until this is on. |
| Do Not Control Shades in an Occupied Room | on | Uses the room's presence sensors. |
| Only Between Sunrise and Sunset | on | Shades are left alone overnight. |
| Close Ahead of a Warm Room | off | Closes a sunlit shade while the zone is idle, before any cooling is needed. See below. |
| Close at Night in Heat Mode | off | Closes shades after dark while the zone heats. Needs Only Between Sunrise and Sunset off. |
| Respect Manual Moves For | on, 120 min | A shade someone moves by hand is left alone this long. |
| Quiet Hours | off, 20:00 to 07:00 | Shades marked Quiet Hours Apply never move between these house-local times. |
| Minimum Time Between Moves | 30 min | Per shade. |
| Cloud Cover From | empty | A `weather.*` entity with `cloud_coverage`. |

Per shade: Window Faces (N, NE, E, SE, S, SW, W, NW), Quiet Hours Apply, Never Control This Shade, and optional Open and Closed positions (0 to 100) for shades that support a position.

Each move is logged under **Settings → Logs**, in the `shades` category, with its reason, for example "Bunk Shade: Sunlit and cooling, so closed." Dev Mode intercepts shade commands like vent commands.

## API

- `GET /api/shades`: settings, the sun, and each shade with its state and current reason
- `PUT /api/shades/settings`
- `PUT /api/shades/{entity_id}` with `room_id`, `facing` and the per-shade options
- `DELETE /api/shades/{entity_id}`

## Closing ahead of a warm room

Without this, a sunlit shade closes only once its zone is cooling, by which time the sun has already warmed the room. With **Close Ahead of a Warm Room** on, a sunlit shade also closes while the zone is idle when both of these hold:

- It is warmer outside than the room's Cool To. A room on a hold or any other single target is left to the ordinary rules: it is always within a degree of its own target, so this would shut its shade whenever it was warm out. In cold weather sun through a window is welcome, so nothing closes early. With no outside sensor this never acts.
- The room follows a band (its targets, or a schedule or occupancy band) and is within 1 °F (0.6 °C) of its Cool To already, or its Smart Learning model expects it to pass it within three hours on a day the forecast says is still warming.

Every other rule still applies first: Never Control, occupied rooms, quiet hours, manual moves, overcast skies, the minimum time between moves, and a room that follows nothing (not in use) is never acted on. A heating zone still opens sunlit shades. The Engine log and the shade's status line read "Sunlit and the room is expected to get too warm, so closed ahead of it."

A shade closed this way is not reopened by HomeClimate when the room cools; it opens again the next time its zone heats, or when someone opens it.
