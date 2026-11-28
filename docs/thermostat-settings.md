# Thermostat settings

Per-thermostat configuration controls how aggressively HomeClimate drives the HVAC and what safety limits apply. They are in **My Home** → the pencil by a zone's name → **Thermostat**. The name, number of vents, temperature limits and occupied temperature are at the top; the rest is under **Advanced Options**, which most houses never need to open.

## Settings reference

| Setting | Default | What it does |
|---|---|---|
| **Temperature Limits** | 65 to 77 °F for a zone added in My Home or from Home Assistant (60 to 85 °F through the API) | Hard clamps — HomeClimate will never ask HA to set the thermostat outside this range, even with overshoot applied. |
| **Room counts as at target within** (deadband) | 0.5 °F | Tolerance for "room at target". `0.5` means a 70 °F target is satisfied at 69.5–70.5 °F. Set to `0` for exact match. A room and a schedule block can each override it — see [Deadband inheritance](#deadband-inheritance). |
| **Run past the target by** | 2 °F | How far past the most demanding room's target HomeClimate sets the thermostat, to keep the HVAC running while easier rooms catch up. |
| **End a run that lasts longer than** | 3 hours | A cycle running longer than this is aborted and vents are restored. Safety net for stuck equipment. |
| **Re-check vents and thermostat every** | 0 (disabled) | How often (minutes) HomeClimate re-reads actual vent and thermostat state from HA and corrects external overrides. `0` disables. Cannot exceed cycle timeout. |
| **Reopen a closed vent after** | 0 (disabled) | Force-reopen a vent after this many minutes even if its room is still at target. Safety valve for systems that need airflow for equipment protection. `0` disables. |
| **Number of Vents** | — (required at registration) | Total registers on this thermostat — **smart vents AND passive ones**. Drives the airflow-floor calculation; see [Safety: Airflow floor](./safety.md#airflow-floor--dead-head-protection). |
| **I have a bypass damper** | unchecked | When ticked, the airflow floor is not enforced — the bypass damper mechanically relieves duct static pressure. |
| **Keep this share of vents open** | 0.333 (one third) | Share of total registers that must stay open. Slider 0.1 – 1.0. Disabled when **Bypass damper installed** is on. |

## Welcome home

Three settings in the **Welcome home** group decide what happens before a [vacation](./vacation-mode.md#welcome-home) return. None is a temperature, so they read the same in °F and °C.

| Setting | Default | Range | What it does |
|---|---|---|---|
| **Get the house ready before I return from vacation** (`welcome_home_enabled`) | on | on / off | Treats every room on this thermostat as occupied once before the return. Off ends the trip at the return time with no welcome home. |
| **Start (minutes before return)** (`welcome_home_lead_min`) | 60 | 0–240, whole minutes | How long before the return it fires. This thermostat leaves the vacation hold at that moment. `0` fires at the return time. |
| **Keep rooms occupied for (hours)** (`welcome_home_hours`) | 1 | 0.25–12 | How long the synthetic presence lasts after it fires. |

The two numbers are disabled while the toggle is off. Helper text on the page: *Before you return from vacation, HomeClimate treats every room on this thermostat as occupied once, so the house is comfortable when you walk in. Rooms with an active schedule follow their schedule; every other room heats or cools to its presence temperature for the time set here, then normal presence detection takes over. Rooms with presence holdover set to 0 are skipped. Ending vacation early fires it straight away.*

They are accepted by `POST /api/thermostats` and `PUT /api/thermostats/{id}` (400 with a clear message outside the ranges above) and are deliberately not exposed on MQTT: they are install-time preferences, not automation targets.

## How these interact with a cycle

- **Overshoot** is applied when the cycle starts; the setpoint is restored to ambient when the cycle ends.
- **Deadband** is checked per-room at every tick to decide whether a room is calling for heating or cooling. It gates cycle start and mid-cycle join (including reopening a served room that has drifted a full band back past its target); a room's vents close at its exact target, not at the edge of the band.
- **Number of Vents and Keep this share of vents open** together set the airflow floor — `ceil(total × fraction) − passive_vents_always_open` smart vents must stay open. If too many would close, the ones furthest from target stay open. Bypass-damper systems skip this enforcement.
- **Reopen a closed vent after** and **cycle timeout** are independent safety valves that can fire mid-cycle.

## Deadband inheritance

The **Deadband** above is the base of a three-level chain. A room can override it, and a schedule block can override the room. Most specific first:

1. The active schedule block's **Allowed Drift** — only while that block is what has the room active. See [Schedules](./schedules.md#deadband-override).
2. The room's **Deadband override** — for that room, whatever activated it. See [Rooms & zones](./rooms-and-zones.md).
3. This **Deadband** — everything else.

Each override is optional and unset means "inherit the next one down", so a system that sets neither behaves exactly as it did before those fields existed. Both overrides are bounded to 0–10 °F. This setting is still what applies to any room with no room-level override, including rooms that are not active at all (overflow conditioning, the vent safety sweep).

## Interaction with pre-cool / pre-heat

The per-room [pre-cool / pre-heat](./precool-presence.md) feature builds on these: while a room coasts it uses a **widened deadband** (which must be ≥ this thermostat **Deadband**) on the side it is drifting from, and the **Min / max setpoint** act as the hard floor/ceiling that always overrides coasting.
