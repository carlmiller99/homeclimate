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

**Today's Plan**, under Targets, shows the next 24 forecast hours as a strip (heating where it is colder outside than the lowest heating target, cooling where warmer than the highest cooling target, coasting between), the next schedule blocks and peak hours on the clock in house time, and yesterday in a sentence: how often and how long heating and cooling ran, and how many warnings were logged. It refreshes every five minutes and changes nothing. With no weather source chosen it shows only yesterday.

Manual controls live here and nowhere else:

- **System On / Off** at the top right: one switch for all of HomeClimate's control. It asks before switching.
- **One card per building**, with the building's heating and cooling targets in its header, its zones' own targets folded underneath, and a **Hold a Room** button. See [Targets](./house-band.md).
- **Each room is one row**: its name and one temperature. Click anywhere on the row for the room's details: its own targets, **Start a Hold** or **Cancel Hold**, whether it is in use and what it follows, **Clear Presence** when occupancy is holding it, its vents, and each sensor's reading. See [Temperature holds](./temperature-holds.md).
- **Suspend Eco**, for the house or for one zone. See [Eco Mode](./eco-mode.md).
- **Vacation mode**. See [Vacation mode](./vacation-mode.md).

## My Home

One page for the whole structure: buildings, the zones in each building, and the rooms in each zone.

- A **zone** is one thermostat and the rooms it serves. A zone has exactly one thermostat; every room belongs to a zone. A zone can be empty, and is not controlled until it has at least one room.
- **Add Building** is at the top of the page. **Add Zone** is inside each building and **Add Room** inside each zone, so a new zone or room goes where its button is.
- **Add Zone** registers a thermostat with the zone's total vent count and the kind of system it is (conventional or heat pump); rooms are added inside the zone afterwards. The kind of system is asked for, never assumed; when Home Assistant shows the signs of a heat pump the form suggests it. The zone's heat is asked for the same way. A zone left as conventional whose thermostat looks like a heat pump is marked **Looks Like a Heat Pump: Check System Type**; the mark opens Edit Zone. **Set Up from Home Assistant** does not ask zone by zone: it sets a new zone up as a heat pump when Home Assistant shows the signs and as conventional with electric strips otherwise, and says so when it finishes.
- To put a zone in no building once every zone has one, add it in a building and set its building to Unassigned under Edit Zone.
- **Edit Zone** opens the zone's equipment (system type, heat pump protection) and its **Thermostat Settings** (setpoint limits, deadband, safety and vacation settings).
- Everything can be deleted. **Delete Zone** is in each zone's header (and under Edit Zone) and removes the zone's rooms with it. A zone's last room can be deleted or moved, leaving the zone empty. Deleting a building keeps its zones and rooms and moves them to Unassigned; the building's mode and zone balance settings go with it.
- Each **room card** lists its hardware in five boxes: Smart Vents, Temperature Sensors, Doors & Windows, Occupancy Sensors, and Shades. Click a box to add, change or remove that kind of device; each search lists only the right kind of device and leads with those in the Home Assistant area named like the room. A temperature sensor is any sensor measured in °F or °C; a vent is any cover that is not a shade, door, gate or window. Occupancy and door/window sensors go by their Home Assistant device class, so if one is missing from a search, set its **Show as** type on the entity in Home Assistant. **Room Settings** holds the room's name, zone, notes and the **Delete Room** button. How the room is heated and cooled is in **Smart Control → Rooms**, and its temperatures are on the **Dashboard**.
- **Outside**, above the buildings: the outside temperature sensors (one, or several that are averaged).
- A pencil beside a building's or a zone's name opens it for editing, renaming or deleting. **Add Room** and **Add Zone** are tiles at the end of the list they add to. **Room Settings** opens as a dialog.
- **Set Up from Home Assistant** builds buildings, zones and rooms from your Home Assistant areas.

## Smart Control

A side menu of sections:

- **Schedules** — one card per room, answering two questions: whether the room is in use (always, never, or while a Home Assistant calendar event is on), and its temperature by time of day while it is. See [Schedules](./schedules.md) and [House band](./house-band.md).
- **Rooms** — how one room is heated and cooled where it differs from its zone: occupancy holdover, temperature offset, deadband, waiting on the weather, its own Eco Mode. See [Rooms & zones](./rooms-and-zones.md).
- **Doors & Windows** — how long a door or window can stay open before its room or zone pauses, per-zone and per-room overrides, and **Shades**. The sensors themselves are added to rooms in My Home. See [Doors & windows](./doors-and-windows.md) and [Shades](./shades.md).
- **Smart Learning** — records how each room heats and cools, and shows how much each room has collected. See [Smart Learning](./smart-learning.md).
- **Auto Mode** — what a building does when its Dashboard mode is Auto: let each zone decide or heat and cool as one, how often it may switch, and how far past its target a room must be first. See [Building mode](./building-mode.md).
- **Forecasts** — the weather source, and the forecast HomeClimate has fetched. See [Forecasts](./forecasts.md).
- **Fireplace** — which entity says a fire is lit, the rooms it warms, and what to do while it burns. Fireplaces are added here, not in My Home, because most rooms don't have one. See [Fireplace](./fireplace.md).
- **Fan** — run the fan alone to mix a zone's rooms while its building holds it to heating or to cooling. See [Fan](./fan.md).
- **Peak Hours** — bank heat or cool in banded rooms ahead of the hours when electricity costs most. See [Peak Hours](./peak-hours.md).
- **Zone Balance** — per building: whether zones are kept within a gap of each other, and the gap. See [Zone Balance](./zone-balance.md).
- **Eco Mode** — per zone: whether targets relax when it is very hot or cold outside, and by how much. A single room's own Eco settings are in Smart Control → Rooms. See [Eco Mode](./eco-mode.md).

## Settings

A side menu of sections:

- **General** — the house time zone, and backup and restore.
- **Sensors** — the sensor-staleness threshold.
- **Integrations** — the MCP server and its access tokens, and the MQTT bridge.
- **Notifications** — which warnings are sent to your phone, through which Home Assistant notify service, and the daily summary. See [Notifications](./notifications.md).
- **Logs** — the live feed, cycle history and log retention.
- **Dev Mode** — the Dev Mode switch and its action log. See [System modes](./system-modes.md).

The gear menu at the top right keeps the System On/Off switch, the theme, the API docs link and Log out.

## Old links

Bookmarks to the old pages still work: `/rooms`, `/zones` and `/thermostats` open My Home, `/schedules` opens Smart Control, and `/logs` and `/dev` open their Settings sections.
