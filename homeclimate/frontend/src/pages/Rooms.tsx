import { useEffect, useState } from "react";
import {
  deleteContactSensor,
  getSmartControl,
  saveContactSensor,
  type ContactSensor,
} from "../smartControlApi";
import Zones from "./Zones";
import {
  getRooms,
  getRoom,
  createRoom,
  updateRoom,
  deleteRoom,
  addSensor,
  removeSensor,
  addVent,
  removeVent,
  updateVentControlMethod,
  testVent,
  addPresence,
  removePresence,
  getThermostats,
  getEntityStates,
  getOutsideTempEntity,
  getSensorHealth,
  type StaleSensor,
  CONTROL_METHOD_LABELS,
  type ControlMethod,
  type Room,
  type RoomVent,
  type ThermostatConfig,
  type EntityState,
} from "../api";
import { useUnit } from "../contexts";
import EntityPicker from "../components/EntityPicker";
import ConfirmDialog from "../components/ConfirmDialog";
import { EcoWorkedExample } from "../components/EcoMode";
import { ECO_NUMERIC_FIELDS, type EcoNumericKey } from "../eco";
import { sanitizeRoomName } from "../roomNames";

// ---------------------------------------------------------------------------
// Room create / edit settings — a full-page view (not a modal). The form is
// long (presence, offset, deadband, pre-cool/pre-heat, Eco Mode overrides), so
// it renders as its own page like "Configure sensors & vents" rather than a
// scrolling dialog that the E2E visual suite can't capture cleanly.
// ---------------------------------------------------------------------------
function RoomSettings({
  room,
  rooms,
  thermostats,
  onCancel,
  onSaved,
  onDeleted,
}: {
  room: Room | null;
  // Every other room, so the sanitized-name uniqueness rule (#519) can be
  // reported as the user types rather than only as an API rejection.
  rooms: Room[];
  thermostats: ThermostatConfig[];
  onCancel: () => void;
  onSaved: (saved: Room) => void;
  onDeleted?: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const doDelete = async () => {
    setConfirmDelete(false);
    setDeleteError(null);
    try {
      await deleteRoom(room!.id);
      onDeleted?.();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Could not delete the room");
    }
  };
  const { toDisplay, toDisplayDelta, displayBound, unitLabel } = useUnit();
  const [name, setName] = useState(room?.name ?? "");
  const [thermostat, setThermostat] = useState(room?.thermostat_entity_id ?? "");
  const [sysTemp, setSysTemp] = useState(
    room?.system_wide_temp != null ? String(toDisplay(room.system_wide_temp)) : ""
  );
  const [holdover, setHoldover] = useState(room?.presence_holdover_hours?.toString() ?? "2");
  const [includeThermoSensor, setIncludeThermoSensor] = useState(
    room?.include_thermostat_sensor ?? false
  );
  const [tempOffset, setTempOffset] = useState(String(toDisplayDelta(room?.temp_offset ?? 0)));
  // Per-room deadband override (Issue #277). Empty string = inherit the
  // thermostat's deadband (stored as null). Holds display units like the other
  // delta fields; convert the °F value from the API via toDisplayDelta on init.
  // Clamp what a STORED band displays as, not just what the user may type. A
  // stored 10 °F — the documented maximum, which the backend accepts — has no
  // 2dp °C form that survives the round trip, so without this the field shows
  // 5.56 in a control capped at 5.55 and every save on the room is rejected,
  // citing a field the user never touched. 0.01 °F is below anything a
  // thermostat resolves, and 10 is the only affected value in 0-10.
  const [deadbandOverride, setDeadbandOverride] = useState(
    room?.deadband_override != null
      ? String(Math.min(toDisplayDelta(room.deadband_override), displayBound(10, "max", "delta")))
      : ""
  );
  const [notes, setNotes] = useState(room?.notes ?? "");
  // Ambient-aware presence suppression / pre-cool / pre-heat (Issue #248).
  const [ambientEnabled, setAmbientEnabled] = useState(room?.ambient_suppression_enabled ?? false);
  const [ambientMode, setAmbientMode] = useState<"any_presence" | "off_schedule_only">(
    room?.ambient_suppression_mode ?? "any_presence"
  );
  const [ambientMinDiff, setAmbientMinDiff] = useState(
    String(toDisplayDelta(room?.ambient_suppression_min_differential ?? 5))
  );
  const [ambientDeadband, setAmbientDeadband] = useState(
    String(toDisplayDelta(room?.ambient_suppression_deadband ?? 2))
  );
  const [ambientWindow, setAmbientWindow] = useState(
    String(room?.ambient_suppression_off_schedule_window_min ?? 60)
  );
  // Eco Mode per-room override (Issue #404). Tri-state enable (inherit the
  // thermostat / force on / force off) plus per-field nullable overrides:
  // empty string = inherit the thermostat value for that field. Temperature
  // fields hold display units and submit the raw value.
  const [ecoEnabled, setEcoEnabled] = useState<"inherit" | "on" | "off">(
    room?.eco_mode_enabled == null ? "inherit" : room.eco_mode_enabled ? "on" : "off"
  );
  const [eco, setEco] = useState<Record<EcoNumericKey, string>>(() => {
    const out = {} as Record<EcoNumericKey, string>;
    for (const { key, kind } of ECO_NUMERIC_FIELDS) {
      const v = room?.[key];
      out[key] =
        v == null ? "" : String(kind === "absolute_temp" ? toDisplay(v) : toDisplayDelta(v));
    }
    return out;
  });
  // The feature is inert without an outside temperature sensor, so the controls
  // are disabled until one is configured (system-wide setting).
  const [hasOutsideSensor, setHasOutsideSensor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getOutsideTempEntity()
      .then((r) => {
        if (!cancelled) setHasOutsideSensor(!!r?.entity_id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Widened deadband must be >= the selected thermostat's deadband. The
  // thermostat stores it in °F; show/compare in display units.
  const selectedThermo = thermostats.find((t) => t.thermostat_entity_id === thermostat);
  const thermoDeadbandDisplay = toDisplayDelta(selectedThermo?.deadband ?? 0.5);

  const save = async () => {
    if (!name.trim()) {
      setError("Room name is required");
      return;
    }
    // Room names must stay unique once sanitised for MQTT topics (#519). The
    // backend enforces this too; checking here means the user finds out while
    // the form is still in front of them.
    if (!sanitizeRoomName(name)) {
      setError("Room name must contain at least one letter or number");
      return;
    }
    const clash = rooms.find(
      (r) => r.id !== room?.id && sanitizeRoomName(r.name) === sanitizeRoomName(name)
    );
    if (clash) {
      setError(
        `Another room is already called "${clash.name}". Room names must be unique, ` +
          "ignoring case, spacing, and punctuation."
      );
      return;
    }
    if (!thermostat.trim()) {
      setError("Thermostat is required");
      return;
    }
    const holdoverVal = parseFloat(holdover);
    if (isNaN(holdoverVal) || holdoverVal < 0) {
      setError("Presence holdover must be >= 0");
      return;
    }

    if (sysTemp) {
      const st = parseFloat(sysTemp);
      // Bounds via displayBound, not a raw toDisplay of the °F limit: rounding
      // moves the bound outward, so toDisplay(40) = 4.4 °C converts back to
      // 39.92 °F and the backend refuses the very minimum this form advertises.
      const minTemp = displayBound(40, "min");
      const maxTemp = displayBound(90, "max");
      if (isNaN(st) || st < minTemp || st > maxTemp) {
        setError(
          // 1dp to match fmtTemp, which every other temperature in the UI uses.
          `Presence-triggered temperature must be between ${minTemp.toFixed(1)}${unitLabel} ` +
            `and ${maxTemp.toFixed(1)}${unitLabel}`
        );
        return;
      }
    }

    // Per-room deadband override (Issue #277). Empty = inherit; otherwise it is
    // a delta and must fall in 0–10°F (display equivalent), matching the
    // backend bound.
    if (deadbandOverride.trim() !== "") {
      const dbVal = parseFloat(deadbandOverride);
      const maxDeadband = displayBound(10, "max", "delta");
      if (isNaN(dbVal) || dbVal < 0 || dbVal > maxDeadband) {
        setError(`Deadband override must be between 0${unitLabel} and ${maxDeadband}${unitLabel}`);
        return;
      }
    }

    // Pre-cool/pre-heat (Issue #248): validate the same way the backend does,
    // but only when the feature is enabled — a disabled room's defaults must
    // never block an unrelated save (e.g. on a wide-deadband thermostat).
    if (ambientEnabled) {
      const minDiffVal = parseFloat(ambientMinDiff);
      if (isNaN(minDiffVal) || minDiffVal < 0) {
        setError("Pre-cool/pre-heat: minimum outside difference must be 0 or greater");
        return;
      }
      const deadbandVal = parseFloat(ambientDeadband);
      if (isNaN(deadbandVal) || deadbandVal < thermoDeadbandDisplay - 1e-6) {
        setError(
          `Pre-cool/pre-heat: widened deadband must be at least the thermostat's deadband ` +
            `(${thermoDeadbandDisplay}${unitLabel})`
        );
        return;
      }
      if (ambientMode === "off_schedule_only") {
        const windowVal = parseInt(ambientWindow, 10);
        if (isNaN(windowVal) || windowVal < 0) {
          setError("Pre-cool/pre-heat: schedule window must be 0 or greater");
          return;
        }
      }
    }

    // Eco Mode (Issue #404) is outdoor-temperature-driven, so it cannot be
    // forced on without a configured outside-temperature sensor.
    if (ecoEnabled === "on" && !hasOutsideSensor) {
      setError(
        "Eco Mode needs an outside-temperature sensor. Configure one on the Thermostats page " +
          "(e.g. via a PirateWeather sensor) before forcing Eco on for this room."
      );
      return;
    }

    setSaving(true);
    setError("");
    try {
      // Temperatures are sent in DISPLAY units; the backend converts to °F
      // on the write boundary via _to_f / _delta_to_f.
      const payload = {
        name: name.trim(),
        thermostat_entity_id: thermostat.trim(),
        system_wide_temp: sysTemp ? parseFloat(sysTemp) : null,
        presence_holdover_hours: parseFloat(holdover) || 0,
        include_thermostat_sensor: includeThermoSensor,
        temp_offset: parseFloat(tempOffset) || 0,
        deadband_override: deadbandOverride.trim() === "" ? null : parseFloat(deadbandOverride),
        ambient_suppression_enabled: ambientEnabled,
        ambient_suppression_mode: ambientMode,
        ambient_suppression_min_differential: parseFloat(ambientMinDiff) || 0,
        ambient_suppression_deadband: parseFloat(ambientDeadband) || 0,
        ambient_suppression_off_schedule_window_min: parseInt(ambientWindow, 10) || 0,
        notes,
        // Eco Mode overrides (Issue #404). Tri-state enable; each numeric field
        // is null (inherit) when left blank, otherwise the raw display value.
        eco_mode_enabled: ecoEnabled === "inherit" ? null : ecoEnabled === "on",
        ...Object.fromEntries(
          ECO_NUMERIC_FIELDS.map(({ key }) => [
            key,
            eco[key].trim() === "" ? null : parseFloat(eco[key]),
          ])
        ),
      };
      const saved = room ? await updateRoom(room.id, payload) : await createRoom(payload);
      onSaved(saved);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Eco Mode inheritance resolvers (Issue #404), in display units: the value
  // inherited from the selected thermostat, and the effective value (room
  // override else inherited) used to render the worked example.
  const ecoInherited = (key: EcoNumericKey, kind: string): number | null => {
    const v = selectedThermo?.[key];
    return v == null ? null : kind === "absolute_temp" ? toDisplay(v) : toDisplayDelta(v);
  };
  const ecoResolved = (key: EcoNumericKey, kind: string): number | null =>
    eco[key].trim() !== "" ? parseFloat(eco[key]) : ecoInherited(key, kind);

  return (
    <div data-testid="room-settings">
      {/* Header with back navigation — mirrors the Configure sensors & vents
          view so both room sub-pages look and behave the same. */}
      <div style={{ marginBottom: "1.25rem" }}>
        <button
          className="btn btn-secondary btn-sm"
          onClick={onCancel}
          style={{ marginBottom: ".75rem" }}
        >
          ← {room ? "Back" : "My Home"}
        </button>
        <div className="page-title">{room ? "Edit Room" : "New Room"}</div>
      </div>

      {error && (
        <div className="badge badge-red" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      <div className="card">
        <div className="form-group">
          <label className="form-label" htmlFor="room-name">
            Room name *
          </label>
          <input
            id="room-name"
            className="form-control"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Master Bedroom"
            autoFocus
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="room-thermostat">
            Thermostat *
          </label>
          {thermostats.length === 0 ? (
            <div className="form-hint" style={{ color: "var(--orange)" }}>
              No thermostats registered yet. Go to the <strong>Thermostats</strong> page first to
              register and name your thermostats.
            </div>
          ) : (
            <select
              id="room-thermostat"
              className="form-control"
              value={thermostat}
              onChange={(e) => setThermostat(e.target.value)}
            >
              <option value="">— select a thermostat —</option>
              {thermostats.map((tc) => (
                <option key={tc.thermostat_entity_id} value={tc.thermostat_entity_id}>
                  {tc.name} ({tc.thermostat_entity_id})
                </option>
              ))}
            </select>
          )}
        </div>

        <hr className="divider" />

        <div className="form-group">
          <label className="form-label" htmlFor="room-sys-temp">
            Presence-triggered temperature ({unitLabel})
            <span className="text-muted" style={{ fontWeight: 400, marginLeft: ".5rem" }}>
              — used when motion/presence detected, no active schedule
            </span>
          </label>
          <input
            id="room-sys-temp"
            className="form-control"
            type="number"
            step="0.5"
            value={sysTemp}
            onChange={(e) => setSysTemp(e.target.value)}
            placeholder="e.g. 72"
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="room-holdover">
            Presence holdover (hours)
            <span className="text-muted" style={{ fontWeight: 400, marginLeft: ".5rem" }}>
              — keep room active this long after last motion; 0 = disabled
            </span>
          </label>
          <input
            id="room-holdover"
            className="form-control"
            type="number"
            step="0.5"
            min="0"
            value={holdover}
            onChange={(e) => setHoldover(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label
            htmlFor="room-include-thermo"
            style={{ display: "flex", alignItems: "center", gap: ".5rem", cursor: "pointer" }}
          >
            <input
              id="room-include-thermo"
              type="checkbox"
              checked={includeThermoSensor}
              onChange={(e) => setIncludeThermoSensor(e.target.checked)}
            />
            <span>Include thermostat's built-in sensor in room temperature average</span>
          </label>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="room-temp-offset">
            Temperature offset ({unitLabel})
          </label>
          <input
            id="room-temp-offset"
            className="form-control"
            type="number"
            step="0.5"
            value={tempOffset}
            onChange={(e) => setTempOffset(e.target.value)}
          />
          <div className="form-hint">
            Compensates for temperature drift after the vent closes. The offset is added to the
            room's measured temperature before comparing to the schedule target — so the vent closes
            earlier, leaving room for drift.
            <br />
            <strong>Example:</strong> your schedule targets 70°F in cooling, but this room always
            ends up at 67°F even after the vent closes. Set offset to <strong>+3</strong> — the
            system will now close the vent when the room reads 67°F (67 + 3 = 70, "at target"), and
            the room drifts to ~70°F instead of 67°F. Leave at 0 if the room reaches its target
            accurately.
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="room-deadband-override">
            Deadband override ({unitLabel})
          </label>
          <input
            id="room-deadband-override"
            className="form-control"
            type="number"
            step="0.1"
            min={0}
            max={displayBound(10, "max", "delta")}
            placeholder={`Inherit thermostat (${thermoDeadbandDisplay}${unitLabel})`}
            value={deadbandOverride}
            onChange={(e) => setDeadbandOverride(e.target.value)}
          />
          <div className="form-hint">
            Replaces the thermostat&rsquo;s deadband for <strong>this room only</strong> — the ±
            tolerance around the target within which the room is &ldquo;at target&rdquo; and calls
            for no heating or cooling. Leave blank to inherit the thermostat&rsquo;s deadband (
            {thermoDeadbandDisplay}
            {unitLabel}).
            <br />
            <strong>Example:</strong> a 70{unitLabel} target with a 1{unitLabel} override means the
            room only calls for cooling above 71{unitLabel} and for heating below 69{unitLabel}. A
            smaller value holds the room tighter to target (more cycling); a larger value is more
            relaxed (less cycling). This is <em>not</em> the widened pre-cool/pre-heat deadband
            below.
          </div>
        </div>

        <hr className="divider" />

        <div className="form-group">
          <label
            htmlFor="room-ambient-enabled"
            style={{ display: "flex", alignItems: "center", gap: ".5rem", cursor: "pointer" }}
          >
            <input
              id="room-ambient-enabled"
              type="checkbox"
              checked={ambientEnabled}
              disabled={!hasOutsideSensor}
              onChange={(e) => setAmbientEnabled(e.target.checked)}
            />
            <span>
              Skip presence heating/cooling when the weather will do it for me (pre-cool / pre-heat)
            </span>
          </label>
          {!hasOutsideSensor && (
            <div className="form-hint" style={{ color: "var(--orange)" }}>
              Add an outside temperature sensor on the <strong>Thermostats</strong> page to use this
              — it cannot be turned on without one.
            </div>
          )}
          <div className="form-hint">
            When presence would heat or cool this room but the outside air will carry it to target
            on its own, HomeClimate skips the HVAC and lets the room drift.
            <br />
            <strong>Example:</strong> your night schedule holds this room at 68{unitLabel} and ends
            at 7am. At 7:30am someone walks in and presence wants 70{unitLabel}. It is already
            warmer outside, so the room will reach 70{unitLabel} on its own — HomeClimate skips the
            heater. The moment the room actually reaches 70{unitLabel}, normal heating/cooling
            resumes.
          </div>
        </div>

        {ambientEnabled && (
          <>
            <div className="form-group">
              <label className="form-label" htmlFor="room-ambient-mode">
                When to apply
              </label>
              <select
                id="room-ambient-mode"
                className="form-control"
                value={ambientMode}
                onChange={(e) =>
                  setAmbientMode(e.target.value as "any_presence" | "off_schedule_only")
                }
              >
                <option value="any_presence">Any presence</option>
                <option value="off_schedule_only">Only after a schedule ends</option>
              </select>
              <div className="form-hint">
                <strong>Example:</strong> &ldquo;Only after a schedule ends&rdquo; skips presence
                heat/cool just after a schedule block ends (the 7am case) but behaves normally
                midday. &ldquo;Any presence&rdquo; applies the check every time presence activates
                the room.
              </div>
            </div>

            {ambientMode === "off_schedule_only" && (
              <div className="form-group">
                <label className="form-label" htmlFor="room-ambient-window">
                  Schedule window (minutes)
                </label>
                <input
                  id="room-ambient-window"
                  className="form-control"
                  type="number"
                  step="5"
                  min="0"
                  value={ambientWindow}
                  onChange={(e) => setAmbientWindow(e.target.value)}
                />
                <div className="form-hint">
                  How long after a schedule ends this still applies. <strong>Example:</strong> 60 =
                  applies until 8am for a schedule ending at 7am.
                </div>
              </div>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="room-ambient-mindiff">
                Minimum outside difference ({unitLabel})
              </label>
              <input
                id="room-ambient-mindiff"
                className="form-control"
                type="number"
                step="0.5"
                min="0"
                value={ambientMinDiff}
                onChange={(e) => setAmbientMinDiff(e.target.value)}
              />
              <div className="form-hint">
                How far past the target the outside temperature must be before coasting.
                <br />
                <strong>Example:</strong> set to 5{unitLabel} with a 70{unitLabel} target,
                HomeClimate only skips heating when it is at least 75{unitLabel} outside, and only
                skips cooling when it is at most 65{unitLabel} outside. If it is only 71{unitLabel}{" "}
                out, that is too little push, so it heats normally. Bigger = only coast when the
                weather strongly favors it.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="room-ambient-deadband">
                Widened deadband ({unitLabel})
              </label>
              <input
                id="room-ambient-deadband"
                className="form-control"
                type="number"
                step="0.5"
                min={thermoDeadbandDisplay}
                value={ambientDeadband}
                onChange={(e) => setAmbientDeadband(e.target.value)}
              />
              <div className="form-hint">
                <strong>Example:</strong> your thermostat&rsquo;s deadband is{" "}
                {thermoDeadbandDisplay}
                {unitLabel}. This widened deadband must be at least that — set it the same or
                higher. With a 70{unitLabel} target and a widened deadband of 3{unitLabel}, while
                coasting up HomeClimate will not call for heat until the room drops 3{unitLabel}{" "}
                below target. The instant the room rises past 70{unitLabel}, normal control resumes
                — it cools at the normal deadband, not the widened one. The thermostat&rsquo;s
                min/max setpoint always overrides this.
              </div>
            </div>
          </>
        )}

        {/* Eco Mode per-room override (Issue #404). Every field inherits the
            thermostat by default (blank); set a value to override just that
            field. A room may enable Eco even if its thermostat has it off. */}
        <hr className="divider" />
        <div className="text-sm" style={{ fontWeight: 600, marginBottom: ".5rem" }}>
          Eco Mode override
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="room-eco-enabled">
            Eco Mode
          </label>
          <select
            id="room-eco-enabled"
            className="form-control"
            value={ecoEnabled}
            onChange={(e) => setEcoEnabled(e.target.value as "inherit" | "on" | "off")}
          >
            <option value="inherit">Inherit thermostat</option>
            <option value="on" disabled={!hasOutsideSensor}>
              On for this room
            </option>
            <option value="off">Off for this room</option>
          </select>
          {!hasOutsideSensor && (
            <div className="form-hint" style={{ color: "var(--orange)" }}>
              Eco Mode needs an outside-temperature sensor — configure one on the{" "}
              <strong>Thermostats</strong> page to force it on here. No physical outdoor thermometer
              in Home Assistant? Add a free weather integration such as{" "}
              <strong>PirateWeather</strong> and point the outside-temperature setting at it.
            </div>
          )}
          <div className="form-hint">
            &ldquo;Inherit&rdquo; follows the thermostat&rsquo;s Eco toggle. Choose &ldquo;On&rdquo;
            to relax this room even when the thermostat has Eco off, or &ldquo;Off&rdquo; to opt
            this room out. Each field below is blank by default and inherits the thermostat; enter a
            value to override just that field.
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
            gap: "1rem",
          }}
        >
          {ECO_NUMERIC_FIELDS.map(({ key, label, step, kind }) => {
            const inherited = ecoInherited(key, kind);
            const placeholder =
              inherited != null
                ? `Inherit (${Math.round(inherited * 10) / 10}${unitLabel})`
                : "Inherit";
            return (
              <div className="form-group" key={key} style={{ marginBottom: 0 }}>
                <label className="form-label" htmlFor={`room-${key}`}>
                  {label} ({unitLabel})
                </label>
                <input
                  id={`room-${key}`}
                  className="form-control"
                  type="number"
                  step={step}
                  placeholder={placeholder}
                  value={eco[key]}
                  onChange={(e) => setEco((prev) => ({ ...prev, [key]: e.target.value }))}
                />
              </div>
            );
          })}
        </div>
        {selectedThermo && (
          <div style={{ marginTop: ".75rem" }}>
            <div className="form-hint" style={{ marginBottom: ".25rem" }}>
              With this room&rsquo;s effective Eco settings:
            </div>
            <EcoWorkedExample
              params={{
                coolingThreshold:
                  ecoResolved("eco_cooling_outdoor_threshold", "absolute_temp") ?? 0,
                coolingFullDrift: ecoResolved("eco_cooling_full_drift_temp", "absolute_temp") ?? 0,
                coolingMaxDrift: ecoResolved("eco_cooling_max_drift", "delta_temp") ?? 0,
                heatingThreshold:
                  ecoResolved("eco_heating_outdoor_threshold", "absolute_temp") ?? 0,
                heatingFullDrift: ecoResolved("eco_heating_full_drift_temp", "absolute_temp") ?? 0,
                heatingMaxDrift: ecoResolved("eco_heating_max_drift", "delta_temp") ?? 0,
              }}
            />
          </div>
        )}

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="room-notes">
            Notes
          </label>
          <textarea
            id="room-notes"
            className="form-control"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-sm" style={{ marginTop: "1.25rem", justifyContent: "flex-end" }}>
        {room && (
          <button
            className="btn btn-danger"
            style={{ marginRight: "auto" }}
            onClick={() => setConfirmDelete(true)}
          >
            Delete Room
          </button>
        )}
        <button className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : room ? "Save changes" : "Create room"}
        </button>
      </div>
      {deleteError && <p className="form-error">{deleteError}</p>}
      {confirmDelete && room && (
        <ConfirmDialog
          title="Delete room?"
          message={`Delete room "${room.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => void doDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entity section inside the configure view
// ---------------------------------------------------------------------------
/** Doors and windows in a room, each pausing the room or its whole zone. */
function DoorsWindowsEditor({
  roomId,
  contacts,
  onChanged,
}: {
  roomId: string;
  contacts: ContactSensor[];
  onChanged: (all: ContactSensor[]) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const run = async (action: () => Promise<{ sensors: ContactSensor[] }>, fallback: string) => {
    setErr(null);
    try {
      onChanged((await action()).sensors);
    } catch (e) {
      setErr(e instanceof Error ? e.message : fallback);
    }
  };
  return (
    <div className="entity-section">
      <div style={{ display: "flex", alignItems: "center", gap: ".5rem", marginBottom: ".3rem" }}>
        <span style={{ fontSize: "1.2rem" }}>🚪</span>
        <span style={{ fontWeight: 700, fontSize: "1rem" }}>Doors &amp; Windows</span>
        {contacts.length > 0 && <span className="badge badge-blue">{contacts.length}</span>}
      </div>
      <p className="text-sm text-muted" style={{ marginBottom: ".75rem" }}>
        An open door or window pauses this room, or its whole zone, after the delay set in Smart
        Control.
      </p>
      <EntityPicker
        domain="binary_sensor"
        placeholder="Search door and window sensors (binary_sensor.*)…"
        onSelect={(id) =>
          void run(
            () => saveContactSensor(id, { room_id: roomId, pauses: "room" }),
            "Could not add the sensor"
          )
        }
      />
      {contacts.length === 0 ? (
        <p className="text-sm text-muted" style={{ marginTop: ".5rem" }}>
          No doors or windows in this room.
        </p>
      ) : (
        <ul className="entity-list">
          {contacts.map((c) => (
            <li key={c.entity_id} className="entity-row">
              <span className="entity-row-name">
                {c.name}
                <span className="font-mono text-sm text-muted"> {c.entity_id}</span>
              </span>
              <label className="sensor-scope">
                Pauses
                <select
                  className="form-control"
                  value={c.pauses}
                  aria-label={`What ${c.name} pauses`}
                  onChange={(e) =>
                    void run(
                      () =>
                        saveContactSensor(c.entity_id, {
                          room_id: roomId,
                          pauses: e.target.value as "room" | "zone",
                        }),
                      "Could not save the sensor"
                    )
                  }
                >
                  <option value="room">This Room</option>
                  <option value="zone">Whole Zone</option>
                </select>
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-label={`Remove ${c.name}`}
                onClick={() =>
                  void run(() => deleteContactSensor(c.entity_id), "Could not remove the sensor")
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}

function EntitySection({
  title,
  description,
  icon,
  items,
  domain,
  pickerPlaceholder,
  emptyHint,
  pickerProps,
  onAdd,
  onRemove,
}: {
  title: string;
  description: string;
  icon: string;
  items: string[];
  domain: string;
  pickerPlaceholder: string;
  emptyHint: string;
  pickerProps?: { hasAttribute?: string; excludeIcon?: string };
  onAdd: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: ".5rem", marginBottom: ".3rem" }}>
        <span style={{ fontSize: "1.2rem" }}>{icon}</span>
        <span style={{ fontWeight: 700, fontSize: "1rem" }}>{title}</span>
        {items.length > 0 && <span className="badge badge-blue">{items.length}</span>}
      </div>
      <p className="text-sm text-muted" style={{ marginBottom: ".75rem" }}>
        {description}
      </p>

      <EntityPicker
        domain={domain}
        placeholder={pickerPlaceholder}
        hasAttribute={pickerProps?.hasAttribute}
        excludeIcon={pickerProps?.excludeIcon}
        onSelect={onAdd}
      />

      {items.length === 0 ? (
        <p className="text-sm text-muted" style={{ marginTop: ".5rem", fontStyle: "italic" }}>
          {emptyHint}
        </p>
      ) : (
        <div className="tag-list">
          {items.map((id) => (
            <span key={id} className="tag">
              <span className="font-mono">{id}</span>
              <button className="tag-remove" title="Remove" onClick={() => onRemove(id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vents table — per-vent control method + test actions
// ---------------------------------------------------------------------------
function VentTable({
  roomId,
  vents,
  onChanged,
}: {
  roomId: string;
  vents: RoomVent[];
  onChanged: () => Promise<void>;
}) {
  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: ".5rem", marginBottom: ".3rem" }}>
        <span style={{ fontSize: "1.2rem" }}>💨</span>
        <span style={{ fontWeight: 700, fontSize: "1rem" }}>Smart Vents</span>
        {vents.length > 0 && <span className="badge badge-blue">{vents.length}</span>}
      </div>
      <p className="text-sm text-muted" style={{ marginBottom: ".75rem" }}>
        Vents in this room, controlled as cover entities. When the room hits target, the system
        closes these vents. Each vent can use a different control method depending on which services
        its HA integration exposes.
      </p>

      <EntityPicker
        domain="cover"
        placeholder="Search vents (cover.*)…"
        onSelect={async (id) => {
          await addVent(roomId, id);
          await onChanged();
        }}
      />

      {vents.length === 0 ? (
        <p className="text-sm text-muted" style={{ marginTop: ".5rem", fontStyle: "italic" }}>
          No vents added yet — search above to add one. Rooms without vents are sensor-only and
          still participate in schedules and presence control.
        </p>
      ) : (
        <div style={{ marginTop: ".75rem", overflowX: "auto" }}>
          <table
            className="vent-table table-cards"
            style={{ width: "100%", borderCollapse: "collapse" }}
          >
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #ddd)" }}>
                <th style={{ padding: ".4rem .5rem" }}>Entity</th>
                <th style={{ padding: ".4rem .5rem" }}>Control method</th>
                <th style={{ padding: ".4rem .5rem" }}>Test</th>
                <th style={{ padding: ".4rem .5rem" }}></th>
              </tr>
            </thead>
            <tbody>
              {vents.map((v) => (
                <VentRow key={v.id} vent={v} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
          <p className="text-sm text-muted" style={{ marginTop: ".5rem", fontStyle: "italic" }}>
            Not sure which method your vent uses? Try it in Home Assistant → Developer Tools →
            Actions against the entity to see which service works.
          </p>
        </div>
      )}
    </div>
  );
}

function VentRow({ vent, onChanged }: { vent: RoomVent; onChanged: () => Promise<void> }) {
  const [method, setMethod] = useState<ControlMethod>(vent.control_method);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"open" | "close" | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const onChangeMethod = async (next: ControlMethod) => {
    setMethod(next);
    setSaving(true);
    setStatus(null);
    try {
      await updateVentControlMethod(vent.room_id, vent.entity_id, next);
      await onChanged();
    } catch (err) {
      setStatus({ ok: false, msg: `Save failed: ${(err as Error).message}` });
      setMethod(vent.control_method);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (direction: "open" | "close") => {
    setTesting(direction);
    setStatus(null);
    try {
      await testVent(vent.entity_id, method, direction);
      setStatus({ ok: true, msg: `${direction === "open" ? "Open" : "Close"} command accepted` });
    } catch (err) {
      setStatus({ ok: false, msg: (err as Error).message });
    } finally {
      setTesting(null);
    }
  };

  return (
    <tr style={{ borderBottom: "1px solid var(--border, #eee)", verticalAlign: "top" }}>
      <td data-label="Entity" style={{ padding: ".5rem" }}>
        <span className="font-mono text-sm">{vent.entity_id}</span>
      </td>
      <td data-label="Control method" className="td-stack" style={{ padding: ".5rem" }}>
        <select
          value={method}
          onChange={(e) => onChangeMethod(e.target.value as ControlMethod)}
          disabled={saving}
          style={{ minWidth: "min(20rem, 100%)", maxWidth: "100%" }}
        >
          {(Object.keys(CONTROL_METHOD_LABELS) as ControlMethod[]).map((m) => (
            <option key={m} value={m}>
              {CONTROL_METHOD_LABELS[m]}
            </option>
          ))}
        </select>
        {status && (
          <div
            className="text-sm"
            style={{
              marginTop: ".25rem",
              color: status.ok ? "var(--success, #1a7f37)" : "var(--danger, #b3261e)",
            }}
          >
            {status.ok ? "✓" : "✗"} {status.msg}
          </div>
        )}
      </td>
      <td data-label="Test" style={{ padding: ".5rem", whiteSpace: "nowrap" }}>
        <button
          className="btn btn-sm"
          onClick={() => runTest("open")}
          disabled={testing !== null || saving}
          style={{ marginRight: ".25rem" }}
        >
          {testing === "open" ? "…" : "Test open"}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => runTest("close")}
          disabled={testing !== null || saving}
        >
          {testing === "close" ? "…" : "Test close"}
        </button>
      </td>
      <td style={{ padding: ".5rem" }}>
        <button className="tag-remove" title="Remove" onClick={() => setConfirmRemove(true)}>
          ×
        </button>
      </td>
      {confirmRemove && (
        <ConfirmDialog
          title="Remove vent?"
          message={`Remove vent "${vent.entity_id}" from this room?`}
          confirmLabel="Remove"
          onConfirm={async () => {
            setConfirmRemove(false);
            await removeVent(vent.room_id, vent.entity_id);
            await onChanged();
          }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Room configure view (sensors, vents, presence)
// ---------------------------------------------------------------------------
function RoomConfigure({
  room,
  thermostats,
  contacts = [],
  onContactsChanged,
  onBack,
  onEditSettings,
  onRoomUpdated,
}: {
  room: Room;
  thermostats: ThermostatConfig[];
  contacts?: ContactSensor[];
  onContactsChanged?: (all: ContactSensor[]) => void;
  onBack: () => void;
  onEditSettings: () => void;
  onRoomUpdated: (r: Room) => void;
}) {
  const { fmtTemp, toDisplayDelta, unitLabel } = useUnit();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{
    kind: "sensor" | "presence";
    id: string;
  } | null>(null);

  const sensors = room.sensors?.map((s) => s.entity_id) ?? [];
  const vents = room.vents?.map((v) => v.entity_id) ?? [];
  const presence = room.presence_sensors?.map((p) => p.entity_id) ?? [];

  const refresh = async () => {
    const updated = await getRoom(room.id);
    onRoomUpdated(updated);
  };

  const wrap = (label: string, fn: (id: string) => Promise<unknown>) => async (id: string) => {
    setBusy(label);
    try {
      await fn(id);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const askToRemove = (kind: "sensor" | "presence") => async (id: string) => {
    setConfirmTarget({ kind, id });
  };

  const doRemoveConfirmedEntity = async () => {
    if (!confirmTarget) return;
    const { kind, id } = confirmTarget;
    setConfirmTarget(null);
    if (kind === "sensor") {
      await wrap("Removing sensor…", (id) => removeSensor(room.id, id))(id);
    } else {
      await wrap("Removing sensor…", (id) => removePresence(room.id, id))(id);
    }
  };

  return (
    <div data-testid="room-configure">
      {/* Header */}
      <div style={{ marginBottom: "1.25rem" }}>
        <button
          className="btn btn-secondary btn-sm"
          onClick={onBack}
          style={{ marginBottom: ".75rem" }}
        >
          ← My Home
        </button>
        <div className="flex-between">
          <div>
            <div className="page-title">{room.name}</div>
            <div className="text-muted" style={{ marginTop: ".2rem", fontSize: ".85rem" }}>
              {thermostats.find((t) => t.thermostat_entity_id === room.thermostat_entity_id)
                ?.name || room.thermostat_entity_id}{" "}
              <span className="font-mono" style={{ fontSize: ".75rem", color: "var(--gray-400)" }}>
                ({room.thermostat_entity_id})
              </span>
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onEditSettings}>
            Room Settings
          </button>
        </div>
      </div>

      {/* Quick status strip */}
      <div className="card" style={{ marginBottom: "1.25rem", padding: ".875rem 1.25rem" }}>
        <div className="flex gap-md" style={{ flexWrap: "wrap" }}>
          <span className="text-sm">
            <strong>{sensors.length}</strong>{" "}
            <span className="text-muted">temp sensor{sensors.length !== 1 ? "s" : ""}</span>
          </span>
          <span className="text-muted">·</span>
          <span className="text-sm">
            <strong>{vents.length}</strong>{" "}
            <span className="text-muted">vent{vents.length !== 1 ? "s" : ""}</span>
          </span>
          <span className="text-muted">·</span>
          <span className="text-sm">
            <strong>{presence.length}</strong>{" "}
            <span className="text-muted">presence sensor{presence.length !== 1 ? "s" : ""}</span>
          </span>
          {room.system_wide_temp != null && (
            <>
              <span className="text-muted">·</span>
              <span className="text-sm text-muted">
                Presence temp: <strong>{fmtTemp(room.system_wide_temp)}</strong>
              </span>
            </>
          )}
          {room.temp_offset !== 0 && (
            <>
              <span className="text-muted">·</span>
              <span className="text-sm text-muted">
                Offset:{" "}
                <strong>
                  {room.temp_offset > 0 ? "+" : ""}
                  {toDisplayDelta(room.temp_offset)}
                  {unitLabel}
                </strong>
              </span>
            </>
          )}
        </div>
      </div>

      {/* Warnings */}
      {sensors.length === 0 && (
        <div
          className="card"
          style={{
            marginBottom: "1rem",
            borderColor: "var(--orange)",
            background: "var(--orange-light)",
          }}
        >
          <p className="text-sm" style={{ color: "var(--orange-text)" }}>
            ⚠ No temperature sensors — this room will be skipped during HVAC cycles.
          </p>
        </div>
      )}
      {vents.length === 0 && (
        <div
          className="card"
          style={{
            marginBottom: "1rem",
            borderColor: "var(--gray-200)",
            background: "var(--gray-50)",
          }}
        >
          <p className="text-sm text-muted">
            ℹ Sensor-only room — no vents configured. This room still participates in schedules and
            presence-based HVAC control; its target temperature contributes to the thermostat
            setpoint. Only vent actuation is skipped.
          </p>
        </div>
      )}

      {busy && (
        <div className="loading" style={{ padding: ".5rem 0", marginBottom: ".5rem" }}>
          <div className="spinner" /> {busy}
        </div>
      )}

      {/* Entity sections */}
      <div className="card">
        <VentTable roomId={room.id} vents={room.vents ?? []} onChanged={refresh} />

        <hr className="divider" />

        <EntitySection
          title="Temperature Sensors"
          description="Used to calculate the room's average temperature. Add all sensors in this room. The thermostat's own sensor can optionally be included in Room Settings."
          icon="🌡"
          items={sensors}
          domain="sensor"
          pickerPlaceholder="Search temperature sensors (sensor.*)…"
          emptyHint="No sensors added yet — search above to add one."
          onAdd={wrap("Adding sensor…", (id) => addSensor(room.id, id))}
          onRemove={askToRemove("sensor")}
        />

        <hr className="divider" />

        <DoorsWindowsEditor
          roomId={room.id}
          contacts={contacts}
          onChanged={(all) => onContactsChanged?.(all)}
        />

        <hr className="divider" />

        <EntitySection
          title="Occupancy Sensors"
          description="When any sensor here detects motion, the room activates at the presence-triggered temperature and stays active for the configured holdover period (reset on each detection)."
          icon="🚶"
          items={presence}
          domain="binary_sensor"
          pickerPlaceholder="Search occupancy and motion sensors (binary_sensor.*)…"
          emptyHint="No occupancy sensors added — the room will only activate via schedules."
          onAdd={wrap("Adding sensor…", (id: string) => addPresence(room.id, id))}
          onRemove={askToRemove("presence")}
        />
      </div>

      {confirmTarget && (
        <ConfirmDialog
          title={confirmTarget.kind === "sensor" ? "Remove sensor?" : "Remove presence sensor?"}
          message={`Remove ${confirmTarget.kind === "sensor" ? "sensor" : "presence sensor"} "${confirmTarget.id}" from this room?`}
          confirmLabel="Remove"
          onConfirm={() => void doRemoveConfirmedEntity()}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live state + countdown helpers
// ---------------------------------------------------------------------------

function formatStaleAge(s: StaleSensor): string {
  if (s.reason === "not_in_cache" || s.age_seconds === null) return "never seen by HA";
  const minutes = Math.round(s.age_seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = s.age_seconds / 3600;
  if (hours < 24) return `${hours.toFixed(1)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function ventLabel(state: EntityState): string {
  // Flair vents report current_tilt_position; standard covers use current_position
  const pos = (state.attributes.current_tilt_position ?? state.attributes.current_position) as
    number | undefined;
  if (pos !== undefined) {
    if (pos === 100) return "Open";
    if (pos === 0) return "Closed";
    return `${pos}%`;
  }
  // Fallback to cover state string
  const s = state.state;
  if (s === "open") return "Open";
  if (s === "closed") return "Closed";
  return s;
}

// ---------------------------------------------------------------------------
// Room list card
// ---------------------------------------------------------------------------
function DeviceSection({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: { id: string; name: string; value: string; tone?: string; tag?: string }[];
}) {
  return (
    <section className="device-section" aria-label={title}>
      <h3 className="device-section-title">
        {title}
        <span className="device-count">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="device-empty">{empty}</p>
      ) : (
        <ul className="device-list">
          {items.map((d) => (
            <li key={d.id} className="device-item" title={d.id}>
              <span className="device-name">{d.name}</span>
              <span className={`device-value${d.tone ? ` device-${d.tone}` : ""}`}>
                {d.value}
                {d.tag && <span className="device-tag">{d.tag}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function friendly(state: EntityState | null | undefined, id: string): string {
  const name = state?.attributes?.friendly_name;
  return typeof name === "string" && name ? name : id;
}

/** A room's hardware: four equal sections, one per kind of device. */
function RoomCard({
  room,
  contacts,
  staleSensors,
  onConfigure,
  onEdit,
}: {
  room: Room;
  contacts: ContactSensor[];
  staleSensors: StaleSensor[];
  onConfigure: () => void;
  onEdit: () => void;
}) {
  const { fmtTemp } = useUnit();
  const sensorIds = room.sensors?.map((s) => s.entity_id) ?? [];
  const ventIds = room.vents?.map((v) => v.entity_id) ?? [];
  const presenceIds = room.presence_sensors?.map((p) => p.entity_id) ?? [];

  const [states, setStates] = useState<Record<string, EntityState | null>>({});
  useEffect(() => {
    const allIds = [...sensorIds, ...ventIds, ...presenceIds];
    if (allIds.length === 0) return;
    getEntityStates(allIds)
      .then(setStates)
      .catch(() => {});
    // Entity ids are re-read when the room changes (by id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  const stale = new Set(staleSensors.map((s) => s.entity_id));
  const vents = ventIds.map((id) => ({
    id,
    name: friendly(states[id], id),
    value: states[id] ? ventLabel(states[id]!) : "…",
  }));
  const temps = sensorIds.map((id) => {
    const n = states[id]?.numeric;
    return {
      id,
      name: friendly(states[id], id),
      value: stale.has(id) ? "Stale" : n == null ? "…" : fmtTemp(n),
      tone: stale.has(id) ? "warn" : undefined,
    };
  });
  const doors = contacts.map((c) => ({
    id: c.entity_id,
    name: c.name,
    value: c.state === "open" ? "Open" : c.state === "closed" ? "Closed" : "Offline",
    tag: c.pauses === "zone" ? "Zone" : undefined,
    tone: c.state === "open" ? "open" : undefined,
  }));
  const occupancy = presenceIds.map((id) => {
    const st = states[id]?.state;
    return {
      id,
      name: friendly(states[id], id),
      value: st === undefined ? "…" : st === "on" ? "Occupied" : st === "off" ? "Clear" : "Offline",
      tone: st === "on" ? "occupied" : undefined,
    };
  });

  return (
    <div className="card room-card">
      <div className="room-card-head">
        <h3 className="card-title room-card-title">{room.name}</h3>
        {staleSensors.length > 0 && (
          <span
            className="badge badge-orange"
            data-testid={`stale-badge-${room.id}`}
            title={staleSensors.map((s) => `${s.entity_id} — ${formatStaleAge(s)}`).join("\n")}
          >
            {staleSensors.length} stale sensor{staleSensors.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="device-grid">
        <DeviceSection title="Smart Vents" empty="No vents" items={vents} />
        <DeviceSection title="Temperature Sensors" empty="No sensors" items={temps} />
        <DeviceSection title="Doors & Windows" empty="None" items={doors} />
        <DeviceSection title="Occupancy Sensors" empty="None" items={occupancy} />
      </div>
      <div className="room-card-actions">
        <button className="btn btn-primary btn-sm" onClick={onConfigure}>
          Edit Devices
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onEdit}>
          Room Settings
        </button>
      </div>
    </div>
  );
}

export default function MyHome() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [zoneIds, setZoneIds] = useState<Set<string>>(new Set());
  const [contacts, setContacts] = useState<ContactSensor[]>([]);
  const [thermostats, setThermostats] = useState<ThermostatConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [configRoom, setConfigRoom] = useState<Room | null>(null);
  const [settings, setSettings] = useState<{
    room: Room | null;
    returnTo: "list" | "configure";
  } | null>(null);
  const [staleByRoom, setStaleByRoom] = useState<Record<string, StaleSensor[]>>({});

  const refreshSensorHealth = async () => {
    try {
      const h = await getSensorHealth();
      const map: Record<string, StaleSensor[]> = {};
      for (const r of h.rooms) map[r.room_id] = r.stale_sensors;
      setStaleByRoom(map);
    } catch {
      // Sensor health is advisory; a failure just hides the stale badges.
    }
  };

  const loadContacts = async () => {
    try {
      setContacts((await getSmartControl()).sensors);
    } catch {
      setContacts([]);
    }
  };

  const load = async () => {
    const [list, tcs] = await Promise.all([getRooms(), getThermostats()]);
    const detailed = await Promise.all(list.map((r) => getRoom(r.id)));
    setRooms(detailed);
    setThermostats(tcs);
    setZoneIds(new Set(tcs.map((t) => t.thermostat_entity_id)));
    setLoading(false);
    await Promise.all([refreshSensorHealth(), loadContacts()]);
  };

  useEffect(() => {
    load();
    // Mount-only fetch; later loads are triggered by the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshSensorHealth();
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" /> Loading My Home…
      </div>
    );

  if (settings) {
    const { room: editing, returnTo } = settings;
    return (
      <RoomSettings
        room={editing}
        rooms={rooms}
        thermostats={thermostats}
        onCancel={() => setSettings(null)}
        onDeleted={async () => {
          setSettings(null);
          setConfigRoom(null);
          setReloadKey((k) => k + 1);
          await load();
        }}
        onSaved={async (saved) => {
          setSettings(null);
          setReloadKey((k) => k + 1);
          await load();
          if (returnTo === "configure" || editing == null) {
            const full = await getRoom(saved.id);
            setConfigRoom(full);
          }
        }}
      />
    );
  }

  if (configRoom) {
    return (
      <RoomConfigure
        room={configRoom}
        thermostats={thermostats}
        contacts={contacts.filter((c) => c.room_id === configRoom.id)}
        onContactsChanged={(all) => setContacts(all)}
        onBack={() => {
          setConfigRoom(null);
          load();
        }}
        onEditSettings={() => setSettings({ room: configRoom, returnTo: "configure" })}
        onRoomUpdated={(updated) => setConfigRoom(updated)}
      />
    );
  }

  const card = (room: Room) => (
    <RoomCard
      key={room.id}
      room={room}
      contacts={contacts.filter((c) => c.room_id === room.id)}
      staleSensors={staleByRoom[room.id] ?? []}
      onConfigure={() => setConfigRoom(room)}
      onEdit={() => setSettings({ room, returnTo: "list" })}
    />
  );
  const loose = rooms.filter((r) => !zoneIds.has(r.thermostat_entity_id));

  return (
    <div>
      <Zones
        reloadKey={reloadKey}
        onChanged={() => void load()}
        extraActions={
          <button
            className="btn btn-primary"
            onClick={() => setSettings({ room: null, returnTo: "list" })}
          >
            Add Room
          </button>
        }
        renderRooms={(zoneId) => {
          const zoneRooms = rooms.filter((r) => r.thermostat_entity_id === zoneId);
          return zoneRooms.length === 0 ? (
            <div className="empty-panel">
              This zone has no rooms. Add one — every zone needs at least one room.
            </div>
          ) : (
            <div className="card-grid">{zoneRooms.map(card)}</div>
          );
        }}
      />
      {loose.length > 0 && (
        <section className="building-group">
          <div className="group-header">
            <h2 className="group-header-title">Rooms Without a Zone</h2>
            <span className="group-header-rule" />
          </div>
          <p className="field-help">
            Open Room Settings and choose a zone for each of these rooms.
          </p>
          <div className="card-grid">{loose.map(card)}</div>
        </section>
      )}
    </div>
  );
}
