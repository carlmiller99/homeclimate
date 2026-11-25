"""
Marshmallow schemas for API request validation and response documentation.
Generated from models.py dataclasses where possible.
"""

from __future__ import annotations

from marshmallow import Schema, fields
from marshmallow_dataclass import class_schema

from .. import models

# --- Base Model Schemas (Auto-generated from models.py) ---

RoomSchema = class_schema(models.Room)
RoomSensorSchema = class_schema(models.RoomSensor)
RoomVentSchema = class_schema(models.RoomVent)
RoomPresenceSensorSchema = class_schema(models.RoomPresenceSensor)
ScheduleSchema = class_schema(models.Schedule)
ThermostatConfigSchema = class_schema(models.ThermostatConfig)
RoomOverrideSchema = class_schema(models.RoomOverride)
ZoneStatusSchema = class_schema(models.ZoneStatus)
RoomLiveStateSchema = class_schema(models.RoomLiveState)
CycleTempSampleSchema = class_schema(models.CycleTempSample)


# --- Custom Request/Response Schemas ---


class ErrorSchema(Schema):
    error = fields.Str(required=True)


class SuccessSchema(Schema):
    ok = fields.Bool(dump_default=True)


class ClearedSchema(Schema):
    cleared = fields.Bool(dump_default=True)


class DeletedSchema(Schema):
    deleted = fields.Str()


class DeletedTrueSchema(Schema):
    deleted = fields.Bool(dump_default=True)


class ScheduleCopyRequestSchema(Schema):
    target_room_ids = fields.List(fields.Str(), required=True)


class ScheduleCopyResultSchema(Schema):
    room_id = fields.Str()
    schedule_id = fields.Str()
    # "created" | "created_disabled_conflict"
    status = fields.Str()
    conflict_with = fields.Str(allow_none=True)


class UpdatedSchema(Schema):
    updated = fields.Bool(dump_default=True)


class RoomResponseSchema(RoomSchema):  # type: ignore[misc, valid-type]
    sensors = fields.List(fields.Nested(RoomSensorSchema))
    vents = fields.List(fields.Nested(RoomVentSchema))
    presence_sensors = fields.List(fields.Nested(RoomPresenceSensorSchema))
    schedules = fields.List(fields.Nested(ScheduleSchema))


class RoomVentUpdateSchema(Schema):
    control_method = fields.Str(required=True)


class RoomVentUpdateResponseSchema(UpdatedSchema):
    control_method = fields.Str()


class VentTestSchema(Schema):
    entity_id = fields.Str(required=True)
    control_method = fields.Str(required=True)
    direction = fields.Str(required=True)


class RoomOverrideRequestSchema(Schema):
    target_temp = fields.Float(required=True)
    # Capped at 8 h (#576): a hold is temporary relief, not a standing setting.
    duration_hours = fields.Float(load_default=2.0)
    # Eco opt-IN (#576). False (the default every pre-#576 caller keeps)
    # preserves #419: the hold is never Eco-relaxed. True lets Eco relax it.
    respect_eco = fields.Bool(load_default=False)


class RoomOverrideStatusSchema(Schema):
    """One live hold as returned by GET /api/overrides (#576)."""

    room_id = fields.Str()
    target_temp = fields.Float()  # raw °F; the frontend converts for display
    expires_at = fields.Str()  # naive-UTC ISO string
    respect_eco = fields.Bool()
    ends_in_seconds = fields.Int()


class RoomActiveStatusSchema(Schema):
    room_id = fields.Str()
    source = fields.Str()  # 'schedule' | 'presence' | 'override' | 'house' | 'safety' | 'idle'
    target_temp = fields.Float(allow_none=True)
    # The band a room following the house is kept in (°F); null for other sources.
    heat_to = fields.Float(allow_none=True)
    cool_to = fields.Float(allow_none=True)
    ends_in_seconds = fields.Int(allow_none=True)
    # #576: the active hold's Eco opt-in; null for every non-override source.
    override_respect_eco = fields.Bool(allow_none=True)
    # #434: stale holdover rows are ignored by the engine and the UI alike.
    presence_holdover_active = fields.Bool()
    # #439: presence was cleared and stays ignored until the room empties.
    presence_suppressed = fields.Bool()
    next_schedule_in_seconds = fields.Int(allow_none=True)
    next_schedule_target = fields.Float(allow_none=True)
    next_schedule_label = fields.Str(allow_none=True)


class RoomActiveStatusResponseSchema(Schema):
    # Mapping of room_id -> RoomActiveStatus
    pass


class EntityStateSchema(Schema):
    state = fields.Str()
    numeric = fields.Float(allow_none=True)
    unit = fields.Str()
    attributes = fields.Dict()


class EntityStateResponseSchema(Schema):
    # Mapping of entity_id -> EntityState
    pass


class HAEntitySchema(Schema):
    entity_id = fields.Str()
    state = fields.Str(allow_none=True)
    friendly_name = fields.Str()


class CycleLogResponseSchema(Schema):
    id = fields.Str()
    thermostat_entity_id = fields.Str()
    started_at = fields.DateTime()
    ended_at = fields.DateTime(allow_none=True)
    mode = fields.Str()
    rooms = fields.Dict()  # JSON object in response
    ended_reason = fields.Str(allow_none=True)
    thermostat_temp_at_start = fields.Float(allow_none=True)
    thermostat_temp_at_end = fields.Float(allow_none=True)
    setpoint_at_start = fields.Float(allow_none=True)
    setpoint_at_end = fields.Float(allow_none=True)
    # Outdoor temperature at the cycle boundaries (°F) — the Eco Mode input.
    outside_temp_at_start = fields.Float(allow_none=True)
    outside_temp_at_end = fields.Float(allow_none=True)
    vents_at_start = fields.Dict(allow_none=True)
    vents_at_end = fields.Dict(allow_none=True)
    had_overflow = fields.Bool()
    # Eco Mode (Issue #404): cycle-level rollup — True when Eco relaxed any room.
    eco_active = fields.Bool()


class CycleRoomDetailSchema(Schema):
    room_id = fields.Str()
    name = fields.Str(allow_none=True)
    source = fields.Str(allow_none=True)
    target_temp = fields.Float()
    reached_at = fields.DateTime(allow_none=True)
    vent_closed_at = fields.DateTime(allow_none=True)
    temp_at_start = fields.Float(allow_none=True)
    temp_at_end = fields.Float(allow_none=True)
    trigger_detail = fields.Dict(allow_none=True)
    joined_at = fields.DateTime(allow_none=True)
    role = fields.Str()
    # Eco Mode measurability (Issue #404).
    requested_target = fields.Float(allow_none=True)
    effective_target = fields.Float(allow_none=True)
    eco_active = fields.Bool()


class CycleVentEventSchema(Schema):
    id = fields.Int()
    timestamp = fields.DateTime()
    entity_id = fields.Str()
    room_id = fields.Str(allow_none=True)
    action = fields.Str()
    reason = fields.Str(allow_none=True)


class CycleSetpointHistorySchema(Schema):
    id = fields.Int()
    timestamp = fields.DateTime()
    setpoint = fields.Float()
    reason = fields.Str(allow_none=True)


class CycleDetailResponseSchema(Schema):
    cycle = fields.Nested(CycleLogResponseSchema)
    rooms = fields.List(fields.Nested(CycleRoomDetailSchema))
    vent_events = fields.List(fields.Nested(CycleVentEventSchema))
    setpoint_history = fields.List(fields.Nested(CycleSetpointHistorySchema))


class EventLogEntrySchema(Schema):
    id = fields.Int()
    timestamp = fields.DateTime()
    level = fields.Str()
    category = fields.Str()
    message = fields.Str()
    details = fields.Dict(allow_none=True)


class SystemStatusSchema(Schema):
    enabled = fields.Bool()
    dev_mode = fields.Bool()
    mcp_enabled = fields.Bool()
    # MQTT bridge runtime toggle (Issue #519) — the twin of mcp_enabled. The
    # broker itself is deployment config; whether HomeClimate connects is runtime.
    mqtt_enabled = fields.Bool()
    # Read-only reflection of the `require_auth` add-on option (#373). Surfaced
    # so the UI can show whether the direct-port/MCP auth boundary is enforced;
    # it is a deployment setting (config.yaml), not a runtime toggle.
    require_auth = fields.Bool()


class MqttStatusSchema(Schema):
    """Resolved MQTT configuration + live connection state (Issue #519).

    Everything except ``enabled`` is deployment config (add-on options / env
    vars) resolved at boot, reported read-only so the Settings panel can show
    what the bridge actually resolved — the topic prefix especially, which is
    derived from the add-on slug and is otherwise invisible.
    """

    enabled = fields.Bool()
    configured = fields.Bool()
    connected = fields.Bool()
    host = fields.Str(allow_none=True)
    port = fields.Int(allow_none=True)
    topic_prefix = fields.Str()
    prefix_is_fallback = fields.Bool()
    discovery = fields.Bool()
    discovery_prefix = fields.Str()
    last_error = fields.Str(allow_none=True)


class AuthStatusSchema(Schema):
    """Public probe the SPA reads on load to decide whether to show login."""

    # Whether the auth boundary is enforced at all (the add-on option).
    require_auth = fields.Bool()
    # Whether THIS caller is already authenticated (ingress, a valid session, or
    # require_auth off). When require_auth is on and this is false, show login.
    authenticated = fields.Bool()
    # How the caller is authenticated: "open" (auth off) | "ingress" | "session"
    # | "none" (require_auth on, no credential → the SPA shows login). Lets the UI
    # show a logout control only for "session" (ingress users have no cookie).
    method = fields.Str()
    # OIDC single sign-on (#464). When enabled, the direct-port login screen shows
    # a "Sign in with <provider>" button (navigating to oidc_login_url) instead of
    # the HA username/password form, which is disabled server-side in this mode.
    oidc_enabled = fields.Bool()
    oidc_provider_name = fields.Str()
    oidc_login_url = fields.Str()


class LoginRequestSchema(Schema):
    """POST /api/auth/login body — an HA username + password validated against
    the Supervisor /auth backend (never stored)."""

    username = fields.Str(required=True)
    password = fields.Str(required=True)


class McpTokenSchema(Schema):
    """A minted MCP token's metadata — NEVER includes the secret or its hash."""

    id = fields.Str()
    label = fields.Str()
    scope = fields.Str(metadata={"description": "read | write | destructive"})
    created_at = fields.Str()
    last_used_at = fields.Str(allow_none=True)


class McpTokenCreateSchema(Schema):
    """POST /api/mcp/tokens body."""

    label = fields.Str(required=True)
    scope = fields.Str(required=True, metadata={"description": "read | write | destructive"})


class McpTokenUpdateSchema(Schema):
    """PATCH /api/mcp/tokens/{token_id} body."""

    scope = fields.Str(required=True, metadata={"description": "read | write | destructive"})


class McpTokenCreatedSchema(McpTokenSchema):
    """The mint response — carries the raw secret ONCE (never stored, never
    returned again)."""

    token = fields.Str(metadata={"description": "The bearer secret — shown once."})


class LogRetentionSettingsSchema(Schema):
    event_log_retention_days = fields.Int(
        metadata={"description": "Days of `event_log` history kept before the purge deletes it."}
    )
    cycle_log_retention_days = fields.Int(
        metadata={
            "description": (
                "Display window (days) for the Cycle History tab. Deletes nothing (Issue #617)."
            )
        }
    )
    metrics_retention_days = fields.Int(
        metadata={
            "description": (
                "Days of `cycle_logs` — and therefore of every metric — kept before the "
                "purge deletes them, cascading to all four child tables (per-room results, "
                "temperature samples, setpoint history, vent events). "
                "0 = keep forever (Issue #617)."
            )
        }
    )


class OutsideTempEntitySettingSchema(Schema):
    entity_id = fields.Str(allow_none=True)
    current_value = fields.Float(allow_none=True)


class SensorStalenessSettingSchema(Schema):
    stale_after_min = fields.Float()


class StaleSensorSchema(Schema):
    entity_id = fields.Str()
    age_seconds = fields.Float(allow_none=True)
    reason = fields.Str()


class StaleRoomSchema(Schema):
    room_id = fields.Str()
    room_name = fields.Str()
    thermostat_entity_id = fields.Str()
    stale_sensors = fields.List(fields.Nested(StaleSensorSchema))


class SensorHealthSchema(Schema):
    stale_after_min = fields.Float()
    rooms = fields.List(fields.Nested(StaleRoomSchema))


class UnavailableThermostatSchema(Schema):
    thermostat_entity_id = fields.Str()
    name = fields.Str()
    reason = fields.Str()
    unavailable_seconds = fields.Float(allow_none=True)
    abort_after_min = fields.Int()
    cycle_running = fields.Bool()


class ThermostatHealthSchema(Schema):
    thermostats = fields.List(fields.Nested(UnavailableThermostatSchema))


class VacationMissedSchema(Schema):
    start_at = fields.Str()
    return_at = fields.Str()


class VacationModeSchema(Schema):
    enabled = fields.Bool(metadata={"description": "True while vacation is ACTIVE now"})
    state = fields.Str(
        metadata={"description": "off | scheduled | active (Issue #728)"},
    )
    start_at = fields.Str(
        allow_none=True,
        metadata={"description": "Scheduled start (ISO-8601 UTC); set only while scheduled"},
    )
    return_at = fields.Str(allow_none=True)
    welcome_home_until = fields.Str(
        allow_none=True,
        metadata={
            "description": ("End of the latest open welcome-home window (ISO-8601 UTC), or null")
        },
    )
    missed = fields.Nested(
        VacationMissedSchema,
        allow_none=True,
        metadata={
            "description": "A scheduled trip missed while HomeClimate was offline, until dismissed"
        },
    )


class VacationModeRequestSchema(Schema):
    return_at = fields.Str(
        required=True,
        metadata={"description": "Return instant, ISO-8601; naive means UTC"},
    )
    start_at = fields.Str(
        allow_none=True,
        metadata={
            "description": (
                "Optional future start (ISO-8601; naive means UTC). Omitted or not in "
                "the future = start now. Rejected (409) while vacation is active."
            )
        },
    )


class EcoSuspendSchema(Schema):
    thermostat_entity_id = fields.Str()
    resume_at = fields.Str(
        allow_none=True,
        metadata={"description": "ISO-8601 UTC; null = not suspended"},
    )


class VacationTestSchema(Schema):
    ok = fields.Bool()
    min_setpoint = fields.Float(allow_none=True)
    max_setpoint = fields.Float(allow_none=True)
    thermostat_state = fields.Dict()


class AppSettingsSchema(Schema):
    temperature_unit = fields.Str()
    unit_change_ack_required = fields.Bool()
    theme = fields.Str(metadata={"description": "UI theme: light | dark | system"})
    timezone = fields.Str(
        metadata={
            "description": (
                "The house's time zone (IANA name, or 'UTC±HH:MM' on the OS fallback). "
                "The UI shows and enters every time in this zone (Issue #729)."
            )
        }
    )
    timezone_fallback = fields.Bool(
        metadata={
            "description": (
                "True when the add-on `timezone` option was missing or invalid and the "
                "zone fell back to the OS/UTC default."
            )
        }
    )
    eco_suspend = fields.Dict(
        keys=fields.Str(),
        values=fields.Str(),
        metadata={
            "description": "Active Eco suspensions: thermostat_entity_id → resume_at (ISO-8601 UTC)"
        },
    )


class ThemeSettingSchema(Schema):
    theme = fields.Str(metadata={"description": "UI theme: light | dark | system"})


class UnitChangeAckResponseSchema(Schema):
    unit_change_ack_required = fields.Bool(dump_default=False)


class RestartResponseSchema(Schema):
    restarting = fields.Bool(dump_default=True)


# --- Metrics Schemas ---


class MetricsSummarySchema(Schema):
    start_date = fields.Str()
    end_date = fields.Str()
    thermostat_entity_id = fields.Str(allow_none=True)
    heating_seconds = fields.Int()
    cooling_seconds = fields.Int()
    cycle_count = fields.Int()
    completed_count = fields.Int()
    timeout_count = fields.Int()
    aborted_count = fields.Int()
    avg_cycle_duration_seconds = fields.Float(allow_none=True)
    duty_cycle_pct = fields.Float()
    avg_outside_temp_at_start = fields.Float(allow_none=True)
    avg_outside_temp_at_end = fields.Float(allow_none=True)
    thermostat_count = fields.Int()
    source_breakdown = fields.Dict()
    # Eco Mode split (Issue #404): cycles/runtime where Eco relaxed a target.
    eco_cycle_count = fields.Int()
    eco_seconds = fields.Int()


class MetricsTimeseriesPointSchema(Schema):
    period = fields.Str()
    value = fields.Float(allow_none=True)
    heating_seconds = fields.Int(required=False)
    cooling_seconds = fields.Int(required=False)


class MetricsTimeseriesSchema(Schema):
    thermostat_entity_id = fields.Str()
    metric = fields.Str()
    granularity = fields.Str()
    start = fields.Str()
    end = fields.Str()
    series = fields.List(fields.Nested(MetricsTimeseriesPointSchema))


class RoomMetricSchema(Schema):
    room_id = fields.Str()
    room_name = fields.Str()
    participation_count = fields.Int()
    participation_rate = fields.Float()
    heating_seconds = fields.Int()
    cooling_seconds = fields.Int()
    avg_time_to_target_seconds = fields.Float(allow_none=True)


class RoomMetricsResponseSchema(Schema):
    thermostat_entity_id = fields.Str()
    start = fields.Str()
    end = fields.Str()
    rooms = fields.List(fields.Nested(RoomMetricSchema))


class CyclesVsOutsideTempPointSchema(Schema):
    cycle_id = fields.Str()
    mode = fields.Str()
    outside_temp = fields.Float()
    outside_temp_at_end = fields.Float(allow_none=True)
    duration_minutes = fields.Float()
    started_at = fields.Str()
    # Eco Mode (Issue #404): True when Eco relaxed a target in this cycle.
    eco_active = fields.Bool()


class CyclesVsOutsideTempResponseSchema(Schema):
    thermostat_entity_id = fields.Str()
    start = fields.Str()
    end = fields.Str()
    points = fields.List(fields.Nested(CyclesVsOutsideTempPointSchema))


class EcoImpactRoomSchema(Schema):
    room_id = fields.Str()
    name = fields.Str(allow_none=True)
    eco_active_cycles = fields.Int()
    avg_drift_f = fields.Float()
    max_drift_f = fields.Float()


class EcoImpactDaySchema(Schema):
    """One local-date bucket of the eco-vs-total split (Issue #442)."""

    date = fields.Str()
    total_cycles = fields.Int()
    total_seconds = fields.Int()
    eco_active_cycles = fields.Int()
    eco_active_seconds = fields.Int()
    avg_drift_f = fields.Float()


class EcoImpactResponseSchema(Schema):
    """Eco Mode impact over a date range (Issue #404)."""

    start_date = fields.Str()
    end_date = fields.Str()
    thermostat_entity_id = fields.Str(allow_none=True)
    total_cycles = fields.Int()
    total_seconds = fields.Int()
    eco_active_cycles = fields.Int()
    eco_active_seconds = fields.Int()
    avg_drift_f = fields.Float()
    days = fields.List(fields.Nested(EcoImpactDaySchema))
    rooms = fields.List(fields.Nested(EcoImpactRoomSchema))


class SeedDemoMetricsRequestSchema(Schema):
    """POST /api/dev/seed-demo-metrics body (Issue #442). Both optional."""

    start_date = fields.Str(required=False)
    days = fields.Int(required=False)


class SeedDemoMetricsResponseSchema(Schema):
    seeded_cycles = fields.Int()
    eco_cycles = fields.Int()
    # Live Feed rows seeded alongside the cycles (Logs page goldens).
    seeded_events = fields.Int()
    thermostats = fields.Int()
    start_date = fields.Str()
    end_date = fields.Str()


class OvershootHistogramSchema(Schema):
    thermostat_entity_id = fields.Str()
    start_date = fields.Str()
    end_date = fields.Str()
    bin_size = fields.Float()
    labels = fields.List(fields.Str())
    counts = fields.List(fields.Int())
    total_room_cycles = fields.Int()
    overshot_count = fields.Int()
    overshot_pct = fields.Float()
    max_overshoot_f = fields.Float()
    avg_overshoot_f = fields.Float()


class HourHeatmapSchema(Schema):
    start_date = fields.Str()
    end_date = fields.Str()
    thermostat_entity_id = fields.Str()
    day_labels = fields.List(fields.Str())
    grid_seconds = fields.List(fields.List(fields.Int()))


class VentTimelineEventSchema(Schema):
    cycle_id = fields.Str()
    timestamp = fields.Str()
    entity_id = fields.Str()
    room_id = fields.Str(allow_none=True)
    action = fields.Str()
    reason = fields.Str(allow_none=True)
    cycle_mode = fields.Str()
    cycle_started_at = fields.Str()
    # NULL while the cycle is running (Issue #607). The timeline deliberately
    # keeps open cycles — see `db.get_vent_events_in_range` — so this schema has
    # to describe every payload that query can produce, exactly as `room_id` and
    # `reason` above already do.
    cycle_ended_at = fields.Str(allow_none=True)


class VentTimelineResponseSchema(Schema):
    thermostat_entity_id = fields.Str()
    start = fields.Str()
    end = fields.Str()
    note = fields.Str()
    events = fields.List(fields.Nested(VentTimelineEventSchema))


class MetricsLiveSchema(Schema):
    thermostat_entity_id = fields.Str()
    as_of = fields.Str()
    today = fields.Nested(MetricsSummarySchema)
    current_cycle = fields.Dict(allow_none=True)
    outside_temp_entity_id = fields.Str(allow_none=True)
    current_outside_temp = fields.Float(allow_none=True)


# --- HomeClimate: buildings and zones ---


class BuildingSchema(Schema):
    id = fields.Str()
    name = fields.Str()
    sort_order = fields.Int()


class BuildingWriteSchema(Schema):
    name = fields.Str()
    sort_order = fields.Int()


class ZoneProfileSchema(Schema):
    thermostat_entity_id = fields.Str()
    name = fields.Str()
    building_id = fields.Str(allow_none=True)
    sort_order = fields.Int()
    system_type = fields.Str(metadata={"description": "conventional | heat_pump"})
    compressor_stages = fields.Int()
    backup_heat = fields.Str(metadata={"description": "electric | gas | none"})
    equipment_running_entity = fields.Str(allow_none=True)
    heat_kit_confirmed = fields.Bool()
    hp_max_step_f = fields.Float(
        metadata={
            "description": "Heat pump: max setpoint above room temperature (delta, °F stored)"
        }
    )
    hp_recovery_f_per_hr = fields.Float(
        metadata={"description": "Heat pump: max warm-up rate (delta per hour, °F stored)"}
    )
    hp_aux_policy = fields.Str(metadata={"description": "avoid | allow (auxiliary heat)"})
    hp_min_runtime_min = fields.Int()
    hp_min_open_heat_pct = fields.Int()
    hp_switchover_gap_min = fields.Int()
    aux_heat_running = fields.Bool(
        metadata={"description": "Auxiliary heat is running now (zone list only)"}
    )
    strips_expected = fields.Bool(
        metadata={"description": "Outdoors is below the compressor lockout (zone list only)"}
    )
    hp_compressor_lockout_f = fields.Float(
        allow_none=True, metadata={"description": "Planning only (absolute, °F stored)"}
    )


class ZoneProfileWriteSchema(Schema):
    building_id = fields.Str(allow_none=True)
    sort_order = fields.Int()
    system_type = fields.Str()
    compressor_stages = fields.Int()
    backup_heat = fields.Str()
    equipment_running_entity = fields.Str(allow_none=True)
    heat_kit_confirmed = fields.Bool()
    hp_max_step_f = fields.Float(
        metadata={
            "description": "Heat pump: max setpoint above room temperature (delta, in the display unit)"
        }
    )
    hp_recovery_f_per_hr = fields.Float(
        metadata={
            "description": "Heat pump: max warm-up rate (delta per hour, in the display unit)"
        }
    )
    hp_aux_policy = fields.Str(metadata={"description": "avoid | allow (auxiliary heat)"})
    hp_min_runtime_min = fields.Int()
    hp_min_open_heat_pct = fields.Int()
    hp_switchover_gap_min = fields.Int()
    hp_compressor_lockout_f = fields.Float(
        allow_none=True, metadata={"description": "Planning only (absolute, in the display unit)"}
    )


class ImportPreviewSchema(Schema):
    zones = fields.List(fields.Dict())
    rooms = fields.List(fields.Dict())
    labels = fields.Dict(keys=fields.Str(), values=fields.Str())
    room_names = fields.List(fields.Str())


class ImportRequestSchema(Schema):
    zones = fields.List(fields.Dict())
    rooms = fields.List(fields.Dict())
    skipped_areas = fields.List(fields.Str())


class ImportResultSchema(Schema):
    zones_added = fields.Int()
    buildings_added = fields.Int()
    rooms_added = fields.Int()
    rooms_updated = fields.Int()
    entities_added = fields.Int()


class SmartControlSettingsSchema(Schema):
    zone_pause_enabled = fields.Bool()
    zone_pause_min = fields.Int(
        metadata={"description": "Minutes open before a zone pauses (1-60)"}
    )
    room_pause_enabled = fields.Bool()
    room_pause_min = fields.Int(
        metadata={"description": "Minutes open before a room pauses (1-60)"}
    )
    resume_min = fields.Int(
        metadata={"description": "Minutes everything must stay closed before resuming (0-30)"}
    )


class SmartControlOverrideSchema(Schema):
    scope = fields.Str(metadata={"description": "zone | room"})
    scope_id = fields.Str(metadata={"description": "Thermostat entity id or room id"})
    key = fields.Str()
    value = fields.Raw()


class SmartControlOverrideWriteSchema(Schema):
    zone_pause_enabled = fields.Bool(allow_none=True)
    zone_pause_min = fields.Int(allow_none=True)
    room_pause_enabled = fields.Bool(allow_none=True)
    room_pause_min = fields.Int(allow_none=True)
    resume_min = fields.Int(
        allow_none=True, metadata={"description": "null clears the override for this key"}
    )


class ContactSensorSchema(Schema):
    entity_id = fields.Str()
    name = fields.Str()
    thermostat_entity_id = fields.Str(allow_none=True)
    room_id = fields.Str(allow_none=True)
    pauses = fields.Str(metadata={"description": "room | zone"})
    state = fields.Str(metadata={"description": "open | closed | offline"})
    open_since = fields.Str(allow_none=True)
    pausing = fields.Bool()


class ContactSensorWriteSchema(Schema):
    room_id = fields.Str(metadata={"description": "The room the door or window is in"})
    pauses = fields.Str(
        metadata={"description": "room (default): pause the room; zone: pause its whole zone"}
    )


class PausedScopeSchema(Schema):
    scope = fields.Str()
    scope_id = fields.Str()
    since = fields.Str()


class FireplaceRoomSchema(Schema):
    room_id = fields.Str()
    fireplace = fields.Str(metadata={"description": "Name of the fireplace setting the room aside"})


class SmartControlSchema(Schema):
    settings = fields.Nested(SmartControlSettingsSchema)
    overrides = fields.List(fields.Nested(SmartControlOverrideSchema))
    sensors = fields.List(fields.Nested(ContactSensorSchema))
    paused = fields.List(fields.Nested(PausedScopeSchema))
    fireplace_rooms = fields.List(fields.Nested(FireplaceRoomSchema))


class ShadeSettingsSchema(Schema):
    auto_enabled = fields.Bool()
    skip_occupied = fields.Bool()
    daylight_only = fields.Bool()
    close_night_heat = fields.Bool()
    respect_manual = fields.Bool()
    manual_hold_min = fields.Int()
    min_move_min = fields.Int()
    quiet_hours = fields.Bool()
    quiet_start = fields.Str(metadata={"description": "HH:MM, house-local"})
    quiet_end = fields.Str(metadata={"description": "HH:MM, house-local"})
    weather_entity = fields.Str(metadata={"description": "weather.* entity for cloud cover"})


class ShadeSchema(Schema):
    entity_id = fields.Str()
    name = fields.Str()
    room_id = fields.Str()
    facing = fields.Str(metadata={"description": "N | NE | E | SE | S | SW | W | NW"})
    never_control = fields.Bool()
    quiet_hours = fields.Bool()
    open_position = fields.Int(allow_none=True)
    closed_position = fields.Int(allow_none=True)
    state = fields.Str(metadata={"description": "open | closed | moving | unknown"})
    reason = fields.Str()
    last_moved_at = fields.Str(allow_none=True)
    hold_until = fields.Str(allow_none=True)


class ShadeWriteSchema(Schema):
    room_id = fields.Str()
    facing = fields.Str()
    never_control = fields.Bool()
    quiet_hours = fields.Bool()
    open_position = fields.Int(allow_none=True)
    closed_position = fields.Int(allow_none=True)


class SunSchema(Schema):
    elevation = fields.Float(allow_none=True)
    azimuth = fields.Float(allow_none=True)
    cloud_pct = fields.Float(allow_none=True)


class ShadesSchema(Schema):
    settings = fields.Nested(ShadeSettingsSchema)
    sun = fields.Nested(SunSchema)
    shades = fields.List(fields.Nested(ShadeSchema))


class HouseBandSchema(Schema):
    house_heat_to = fields.Float(
        allow_none=True, metadata={"description": "Heat rooms below this. Display unit in, °F out."}
    )
    house_cool_to = fields.Float(
        allow_none=True, metadata={"description": "Cool rooms above this. Display unit in, °F out."}
    )


class RoomSwitchesSchema(Schema):
    in_use = fields.Bool(metadata={"description": "Off: the room asks for nothing but a hold"})
    use_schedules = fields.Bool(metadata={"description": "Off: schedules are skipped"})
    use_presence = fields.Bool(metadata={"description": "Off: occupancy sets no target"})


class RoomCalendarSchema(Schema):
    entity_id = fields.Str(metadata={"description": "The calendar the room's In Use follows"})
    match_text = fields.Str(
        metadata={"description": "Only events whose title contains this; empty for any event"}
    )
    lead_min = fields.Int(metadata={"description": "Minutes before an event to be in use (0-1440)"})


class HouseRoomSchema(RoomSwitchesSchema):
    room_id = fields.Str()
    calendar = fields.Nested(RoomCalendarSchema, allow_none=True)


class HouseSchema(HouseBandSchema):
    min_gap = fields.Float(metadata={"description": "°F delta required between the two"})
    low = fields.Float(metadata={"description": "°F, lowest heat-to allowed"})
    high = fields.Float(metadata={"description": "°F, highest cool-to allowed"})
    rooms = fields.List(fields.Nested(HouseRoomSchema))


class FireplaceWriteSchema(Schema):
    name = fields.Str()
    entity_id = fields.Str(metadata={"description": "The entity that is on while the fire is lit"})
    room_ids = fields.List(fields.Str(), metadata={"description": "Every room the fire warms"})
    cooldown_min = fields.Int(metadata={"description": "0 to 240"})
    control = fields.Str(metadata={"description": "off, watch or on"})


class FireplaceSchema(FireplaceWriteSchema):
    id = fields.Str()
    state = fields.Str(metadata={"description": "lit, cooling, out or unknown"})
    lit_since = fields.Str(allow_none=True)
    cooling_until = fields.Str(allow_none=True)
    setting_aside = fields.Bool(metadata={"description": "Its rooms are out of demand right now"})
    signal_lost = fields.Bool(
        metadata={"description": "Held as cooling because its signal stopped reporting while lit"}
    )


class FireplacesSchema(Schema):
    fireplaces = fields.List(fields.Nested(FireplaceSchema))


class ForecastSettingsSchema(Schema):
    enabled = fields.Bool()
    weather_entity = fields.Str(metadata={"description": "A weather entity, or empty"})


class ForecastDaySchema(Schema):
    date = fields.Str(metadata={"description": "House-local date"})
    starts_at = fields.Str(metadata={"description": "The first forecast hour of that date"})
    high = fields.Float(metadata={"description": "°F, over the forecast hours of that date"})
    low = fields.Float(metadata={"description": "°F, over the forecast hours of that date"})
    hours = fields.Int()


class ForecastHourSchema(Schema):
    at = fields.Str()
    temp = fields.Float(metadata={"description": "°F"})
    cloud_pct = fields.Int(allow_none=True)
    precip_pct = fields.Int(allow_none=True)
    condition = fields.Str()


class ForecastSchema(Schema):
    settings = fields.Nested(ForecastSettingsSchema)
    weather_entity = fields.Str(
        metadata={"description": "The entity in use, set here or in Shades"}
    )
    shared_with_shades = fields.Bool()
    state = fields.Str(metadata={"description": "off, no_entity, none, kept or fresh"})
    problem = fields.Str(allow_none=True)
    fetched_at = fields.Str(allow_none=True)
    covers_until = fields.Str(allow_none=True)
    days = fields.List(fields.Nested(ForecastDaySchema))
    hours = fields.List(fields.Nested(ForecastHourSchema))


class LearningSettingsSchema(Schema):
    sampling_enabled = fields.Bool()
    sample_retention_days = fields.Int()


class LearningRoomSchema(Schema):
    room_id = fields.Str()
    name = fields.Str()
    thermostat_entity_id = fields.Str()
    samples = fields.Int()
    days = fields.Float()
    with_temperature_pct = fields.Int()
    first_sample_at = fields.Str(allow_none=True)
    last_sample_at = fields.Str(allow_none=True)


class LearningSchema(Schema):
    settings = fields.Nested(LearningSettingsSchema)
    samples = fields.Int()
    collecting_since = fields.Str(allow_none=True)
    last_sample_at = fields.Str(allow_none=True)
    sample_every_min = fields.Int()
    checked_at = fields.Str()
    rooms = fields.List(fields.Nested(LearningRoomSchema))


class AuxSummarySchema(Schema):
    episodes = fields.Int(metadata={"description": "Auxiliary heat episodes that started in range"})
    minutes = fields.Float(metadata={"description": "Total auxiliary heat minutes"})
