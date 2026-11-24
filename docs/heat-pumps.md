# Heat pumps

Mark a zone as a heat pump on the **Zones** page (System Type → Heat Pump). HomeClimate then adds **Heat Pump Protection** on top of the thermostat's own settings, to keep the compressor doing the work so backup (aux) heat stays off.

> **Scope:** backup heat, defrost and the compressor's low-temperature lockout stay with the thermostat. HomeClimate never commands them. It only avoids giving the thermostat a reason to call for backup heat, and logs it when it runs.

## Guards

| Setting | Default | What it does |
|---|---|---|
| Max Setpoint Step | 1 °F | When heating, the setpoint is never more than this far above the thermostat's own reading. A large gap between setpoint and room is what makes most thermostats call for backup heat. The capped setpoint rounds down to a whole degree, but never below half a degree over the reading, so the heat pump still runs. |
| Max Recovery Rate | 2 °F/hr | During a warm-up the cap also climbs no faster than this from the reading when the cycle started. Each tick the setpoint is raised as the room warms, until the rooms' targets are reached. |
| Minimum Run Time | 15 min | A floor over the thermostat's Minimum cycle runtime. |
| Minimum Open Vents When Heating | 50 % | A floor over the thermostat's airflow fraction, only while heating. Heat pumps move more air and run cooler supply air. |
| Minimum Time Between Heat and Cool | 60 min | A cycle does not start in the opposite direction until this long after the last cycle ended. Protects the reversing valve in swing weather. |
| Compressor Lockout Below | empty | Copy the thermostat's setting here. Stored for planning only. |

Floors never loosen a stricter thermostat setting, and the stored thermostat settings are never changed. Temperatures are entered in the display unit; step and rate are temperature differences.

## Backup heat

Set **Equipment Running Source** on the zone to an ecobee cloud thermostat (its `equipment_running` attribute) or to a power sensor on the strip-heat circuit (on above 500 W). Each backup heat episode is logged under **Logs → engine** with its length, and the zone shows **Backup Heat Running** while it lasts.

If Backup Heat is set to electric strips and the heater kit has not been confirmed, the zone editor asks you to confirm one is installed.
