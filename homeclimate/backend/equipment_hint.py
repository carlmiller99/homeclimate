"""What kind of system a thermostat looks like, from Home Assistant's entities.

Nothing here decides a zone's equipment: the person adding the zone does. This
only offers a suggestion ("this looks like a heat pump, is that right?") so a
heat pump is not left on the conventional settings because nobody was asked.

Two signs are read, both from the ecobee integration:

* an ``aux heat only`` switch beside the thermostat, which the integration
  creates only for a thermostat configured with auxiliary heat;
* the thermostat's ``equipment_running`` attribute naming a heat pump stage or
  auxiliary heat right now.

No sign means "cannot tell", never "conventional".
"""

from __future__ import annotations

from typing import Any

HEAT_PUMP = "heat_pump"

# Why the suggestion was made, for the wording shown beside it.
AUX_SWITCH = "aux_switch"
RUNNING = "equipment_running"


def _object_id(entity_id: str) -> str:
    return entity_id.split(".", 1)[1] if "." in entity_id else entity_id


def looks_like(ha: Any, thermostat_entity_id: str) -> dict[str, Any] | None:
    """A suggested system type for this thermostat, or None when nothing shows."""
    try:
        state = ha.get_state(thermostat_entity_id)
        switch = ha.get_state(f"switch.{_object_id(thermostat_entity_id)}_aux_heat_only")
    except Exception:
        return None
    running = str(((state or {}).get("attributes") or {}).get("equipment_running") or "").lower()
    if switch is not None:
        return {"system_type": HEAT_PUMP, "auxiliary_heat": True, "reason": AUX_SWITCH}
    if "heatpump" in running or "aux" in running:
        return {"system_type": HEAT_PUMP, "auxiliary_heat": "aux" in running, "reason": RUNNING}
    return None
