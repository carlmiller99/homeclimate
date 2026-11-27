# Heat pumps

Mark a zone as a heat pump on the **Zones** page (System Type → Heat Pump). HomeClimate then adds **Heat Pump Protection** on top of the thermostat's own settings, to keep the compressor doing the work so backup (aux) heat stays off.

> **Scope:** backup heat, defrost and the compressor's low-temperature lockout stay with the thermostat. HomeClimate never commands them. It only avoids giving the thermostat a reason to call for auxiliary heat (unless you allow it), and logs it when it runs.

## When to Use Auxiliary Heat

Auxiliary heat (also called aux, backup or emergency heat) is the electric heater strips or gas furnace in the air handler. The thermostat turns it on when the heat pump can't keep up: on very cold days, or when the setpoint jumps several degrees. It heats quickly, but electric strips cost about two to three times as much to run as the heat pump.

| Setting | What HomeClimate does |
|---|---|
| **Avoid** (default) | Raises the heat in small steps, starts warm-ups early, and eases off for an hour if auxiliary heat comes on anyway. Rooms warm more slowly. |
| **Allow When Needed** | Sets the heat like a conventional system. Max Setpoint Step, Max Recovery Rate, early warm-ups and the back-off are off; everything else below still applies. |

## Guards

| Setting | Default | What it does |
|---|---|---|
| Max Setpoint Step | 1 °F | When heating, the setpoint is never more than this far above the thermostat's own reading. A large gap between setpoint and room is what makes most thermostats call for auxiliary heat. The capped setpoint rounds down to a whole degree, but never below half a degree over the reading, so the heat pump still runs. |
| Max Recovery Rate | 2 °F/hr | During a warm-up the cap also climbs no faster than this from the reading when the cycle started. Each tick the setpoint is raised as the room warms, until the rooms' targets are reached. |
| Minimum Run Time | 15 min | A floor over the thermostat's Minimum cycle runtime. |
| Minimum Open Vents When Heating | 50 % | A floor over the thermostat's airflow fraction, only while heating. Heat pumps move more air and run cooler supply air. |
| Minimum Time Between Heat and Cool | 60 min | A cycle does not start in the opposite direction until this long after the last cycle ended. Protects the reversing valve in swing weather. |
| Compressor Lockout Below | empty | Copy the thermostat's setting here. Below it, the zone is in Strips Expected (needs the outdoor temperature sensor). |

## Also built in

| Behaviour | What happens |
|---|---|
| Early warm-ups | When a schedule block is about to raise a room's target, heating starts early enough to arrive on time at the Max Recovery Rate, up to 3 hours ahead. Only while the thermostat is in heat mode and auxiliary heat is avoided. Once started, a warm-up is kept until its block begins. Logged once per block. |
| Back-off | When auxiliary heat starts, the setpoint step is held to 0.5 °F for an hour and the setpoint is re-sent at once. |
| Defrost allowance | A heating cycle may run 1.5 times the thermostat's cycle timeout, since defrost and small steps make warm-ups slower. |
| Strips Expected | When the outdoor sensor reads below Compressor Lockout Below, the compressor can't run. Warm-ups don't start early, the heating deadband widens by 1 °F to cut strip runtime, and the Zones page shows Strips Expected. |
| Metrics | Each auxiliary heat episode is stored; Metrics shows the minutes and episodes for the selected zone and range. |

Floors never loosen a stricter thermostat setting, and the stored thermostat settings are never changed. Temperatures are entered in the display unit; step and rate are temperature differences.

## Seeing auxiliary heat

Set **Backup Heat Sensor** on the zone to an ecobee cloud thermostat (its `equipment_running` attribute) or to a power sensor on the strip-heat circuit (on above 500 W). Each episode is logged under **Logs → engine** with its length, and the zone shows **Auxiliary Heat Running** while it lasts.

If Auxiliary Heat is set to electric strips and the heater kit has not been confirmed, the zone editor asks you to confirm one is installed.
