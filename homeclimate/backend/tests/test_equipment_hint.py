"""What a thermostat looks like, from Home Assistant's entities."""

from backend import equipment_hint


class _HA:
    def __init__(self, states, broken=False):
        self.states = states
        self.broken = broken

    def get_state(self, entity_id):
        if self.broken:
            raise RuntimeError("no connection")
        return self.states.get(entity_id)


def _climate(running=None):
    return {
        "state": "heat",
        "attributes": {} if running is None else {"equipment_running": running},
    }


def test_an_aux_heat_only_switch_means_a_heat_pump_with_auxiliary_heat():
    ha = _HA({"climate.south": _climate(), "switch.south_aux_heat_only": {"state": "off"}})
    assert equipment_hint.looks_like(ha, "climate.south") == {
        "system_type": "heat_pump",
        "auxiliary_heat": True,
        "reason": "aux_switch",
    }


def test_a_running_heat_pump_stage_is_a_sign_without_auxiliary_heat():
    ha = _HA({"climate.south": _climate("fan,heatPump")})
    assert equipment_hint.looks_like(ha, "climate.south") == {
        "system_type": "heat_pump",
        "auxiliary_heat": False,
        "reason": "equipment_running",
    }


def test_a_heat_pump_running_with_auxiliary_heat_says_so():
    ha = _HA({"climate.south": _climate("fan,heatPump2,auxHeat1")})
    assert equipment_hint.looks_like(ha, "climate.south") == {
        "system_type": "heat_pump",
        "auxiliary_heat": True,
        "reason": "equipment_running",
    }


def test_auxiliary_heat_alone_is_no_sign():
    # ecobee reports a conventional furnace's heat stages as auxHeat1/auxHeat2.
    ha = _HA({"climate.north": _climate("fan,auxHeat1")})
    assert equipment_hint.looks_like(ha, "climate.north") is None


def test_no_sign_is_cannot_tell_not_conventional():
    assert (
        equipment_hint.looks_like(
            _HA({"climate.north": _climate("fan,compCool1")}), "climate.north"
        )
        is None
    )
    assert equipment_hint.looks_like(_HA({"climate.north": _climate()}), "climate.north") is None
    assert equipment_hint.looks_like(_HA({}), "climate.gone") is None
    assert equipment_hint.looks_like(_HA({}), "not-an-entity") is None


def test_an_unreadable_home_assistant_gives_no_suggestion():
    assert equipment_hint.looks_like(_HA({}, broken=True), "climate.south") is None
