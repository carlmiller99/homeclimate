# Where things live

HomeClimate has five tabs. One rule decides what goes where, and where new features will go:

| Tab | What it is for |
|---|---|
| **Dashboard** | Shows status and allows manual control. |
| **My Home** | Shows and edits structure and hardware. |
| **Smart Control** | Tunes what HomeClimate does on its own: scheduling, learning, automatic pauses. |
| **Analytics** | Charts and history. |
| **Settings** | The house time zone, sensors used everywhere, integrations, logs, and Dev Mode. |

## Dashboard

Zones are grouped by building, and every room is listed under its zone with its temperature, whether or not it is part of a running cycle.

Manual controls live here and nowhere else:

- **System On / Off** at the top right: one switch for all of HomeClimate's control. It asks before switching.
- The **House** band at the top: one Heat To and Cool To for every room. See [House band](./house-band.md).
- **Options** on each room: whether it is in use, and whether it follows its schedules and occupancy or the house band.
- **Hold** and **Cancel Hold** on each room, and the page-level **Temporary hold** button. See [Temperature holds](./temperature-holds.md).
- **Clear Presence** on a room that presence is holding active.
- **Suspend Eco**, for the house or for one zone. See [Eco Mode](./eco-mode.md).
- **Vacation mode**. See [Vacation mode](./vacation-mode.md).

## My Home

One page for the whole structure: buildings, the zones in each building, and the rooms in each zone.

- A **zone** is one thermostat and the rooms it serves. A zone has exactly one thermostat and at least one room; every room belongs to a zone.
- **Add Zone** registers a thermostat together with its first room and the zone's total vent count.
- **Edit Zone** opens the zone's equipment (system type, heat pump protection) and its **Thermostat Settings** (setpoint limits, deadband, safety and vacation settings). **Delete Zone** is there too, and removes the zone's rooms with it.
- A zone's last room can't be deleted or moved to another zone. Add another room first, or delete the zone.
- Each **room card** lists its hardware in four sections: Smart Vents, Temperature Sensors, Doors & Windows, and Occupancy Sensors. **Edit Devices** adds and removes them. **Room Settings** holds the room's name, zone, temperatures and the **Delete Room** button.
- **Set Up from Home Assistant** builds buildings, zones and rooms from your Home Assistant areas.

## Smart Control

A side menu of sections:

- **Schedules** — per-room time blocks, and **Rooms In Use by Calendar**: a room can be in use only while a Home Assistant calendar event is on. See [Schedules](./schedules.md) and [House band](./house-band.md).
- **Doors & Windows** — how long a door or window can stay open before its room or zone pauses, per-zone and per-room overrides, and **Shades**. The sensors themselves are added to rooms in My Home. See [Doors & windows](./doors-and-windows.md) and [Shades](./shades.md).
- **Smart Learning** — records how each room heats and cools, and shows how much each room has collected. See [Smart Learning](./smart-learning.md).
- **Forecasts** — the weather source, and the forecast HomeClimate has fetched. See [Forecasts](./forecasts.md).
- **Fireplace** — which entity says a fire is lit, the rooms it warms, and what to do while it burns. Fireplaces are added here, not in My Home, because most rooms don't have one. See [Fireplace](./fireplace.md).

## Settings

A side menu of sections:

- **General** — the house time zone, and backup and restore.
- **Sensors** — the outside temperature sensor and the sensor-staleness threshold.
- **Integrations** — the MCP server and its access tokens, and the MQTT bridge.
- **Logs** — the live feed, cycle history and log retention.
- **Dev Mode** — the Dev Mode switch and its action log. See [System modes](./system-modes.md).

The gear menu at the top right keeps the System On/Off switch, the theme, the API docs link and Log out.

## Old links

Bookmarks to the old pages still work: `/rooms`, `/zones` and `/thermostats` open My Home, `/schedules` opens Smart Control, and `/logs` and `/dev` open their Settings sections.
