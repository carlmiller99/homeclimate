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
  type RoomDeviceKind,
  type RoomVent,
  type ThermostatConfig,
  type EntityState,
} from "../api";
import { useUnit } from "../contexts";
import EntityPicker from "../components/EntityPicker";
import ConfirmDialog from "../components/ConfirmDialog";
import { EcoWorkedExample } from "../components/EcoMode";
import { ECO_NUMERIC_FIELDS, type EcoNumericKey } from "../eco";
import { coolToValue } from "../bands";
import CoolToField from "../components/CoolToField";
import { sanitizeRoomName } from "../roomNames";
import RoomShades from "../components/RoomShades";
import { getShades, type Shades } from "../shadesApi";

// ---------------------------------------------------------------------------
// Room create / edit settings — a full-page view (not a modal). The form is
// long (presence, offset, deadband, pre-cool/pre-heat, Eco Mode overrides), so
// it renders as its own page like "Configure sensors & vents" rather than a
// scrolling dialog that the E2E visual suite can't capture cleanly.
// ---------------------------------------------------------------------------
const NO_TEMP_SENSORS =
  "No temperature sensors selected. This room cannot be controlled independently, or contribute temperature information, without them.";
const NO_VENTS =
  "No smart vents selected. This room cannot be controlled independently without them.";
const NO_OCCUPANCY =
  "No occupancy sensors selected. This room cannot use occupancy smart features without them.";

function RoomSettings({
  room,
  zoneId,
  rooms,
  thermostats,
  onCancel,
  onSaved,
  onDeleted,
}: {
  room: Room | null;
  /** For a new room: the zone whose Add Room button opened the form. */
  zoneId?: string;
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
  const [thermostat, setThermostat] = useState(room?.thermostat_entity_id ?? zoneId ?? "");
  const [sysTemp, setSysTemp] = useState(
    room?.system_wide_temp != null ? String(toDisplay(room.system_wide_temp)) : ""
  );
  // An optional Cool To makes the occupancy target a band. Display units, sent as typed.
  const [presenceCoolTo, setPresenceCoolTo] = useState(
    room?.presence_cool_to != null ? String(toDisplay(room.presence_cool_to)) : ""
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
    if (presenceCoolTo.trim() !== "" && !sysTemp) {
      setError("Cool To needs a presence-triggered temperature to pair with");
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
        "Eco Mode needs an outside-temperature sensor. Configure one in Settings, Sensors " +
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
        // Sent when there is one, or when one is being taken away.
        ...(room && (presenceCoolTo.trim() !== "" || room.presence_cool_to != null)
          ? { presence_cool_to: sysTemp ? coolToValue(presenceCoolTo) : null }
          : {}),
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
              No zones yet. Go back to My Home and use <strong>Add Zone</strong> first.
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

        {room && (
          <CoolToField id="room-sys-cool-to" value={presenceCoolTo} onChange={setPresenceCoolTo} />
        )}

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
            Use this when the room always ends up warmer or cooler than its target. Example: if it
            settles 3° too cool, enter +3.
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
            How close to its target this room must be before heating or cooling stops. Leave blank
            to use the zone&rsquo;s setting ({thermoDeadbandDisplay}
            {unitLabel}).
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
              Add an outside temperature sensor in <strong>Settings</strong>, Sensors to use this —
              it cannot be turned on without one.
            </div>
          )}
          <div className="form-hint">
            When someone walks in and the weather will bring the room to temperature by itself,
            HomeClimate waits instead of running the equipment.
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
                Choose whether to wait every time someone walks in, or only just after a schedule
                ends.
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
                How much warmer or cooler than the target it must be outside before HomeClimate
                waits. A bigger number means it waits less often.
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
                How far the room may slip from its target while waiting on the weather. It must be
                at least {thermoDeadbandDisplay}
                {unitLabel}, the zone&rsquo;s own setting.
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
              Eco Mode needs to know the outside temperature. Choose a sensor or a weather service
              in <strong>Settings</strong>, Sensors.
            </div>
          )}
          <div className="form-hint">
            Inherit follows the zone&rsquo;s Eco Mode setting. On or Off sets it for this room only,
            and a blank field below uses the zone&rsquo;s value.
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
  roomName,
  contacts,
  onChanged,
}: {
  roomId: string;
  roomName: string;
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
        kind="contacts"
        room={roomName}
        placeholder="Search door and window sensors…"
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
  kind,
  roomName,
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
  kind: RoomDeviceKind;
  roomName: string;
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
        kind={kind}
        room={roomName}
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
  roomName,
  vents,
  onChanged,
}: {
  roomId: string;
  roomName: string;
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
        kind="vents"
        room={roomName}
        placeholder="Search vents…"
        onSelect={async (id) => {
          await addVent(roomId, id);
          await onChanged();
        }}
      />

      {vents.length === 0 ? (
        <p className="text-sm text-muted" style={{ marginTop: ".5rem", fontStyle: "italic" }}>
          No vents added yet — search above to add one.
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
// One kind of device in one room (My Home → a room → a device box)
// ---------------------------------------------------------------------------
export type DeviceKind = "vents" | "temps" | "doors" | "occupancy" | "shades";

const DEVICE_TITLES: Record<DeviceKind, string> = {
  vents: "Smart Vents",
  temps: "Temperature Sensors",
  doors: "Doors & Windows",
  occupancy: "Occupancy Sensors",
  shades: "Shades",
};

function RoomDeviceModal({
  room,
  kind,
  contacts = [],
  shades,
  onContactsChanged,
  onShadesChanged,
  onRoomUpdated,
  onClose,
}: {
  room: Room;
  kind: DeviceKind;
  contacts?: ContactSensor[];
  /** Null when the shades could not be read. */
  shades: Shades | null;
  onContactsChanged?: (all: ContactSensor[]) => void;
  onShadesChanged: (all: Shades) => void;
  onRoomUpdated: (r: Room) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{
    kind: "sensor" | "presence";
    id: string;
  } | null>(null);

  const sensors = room.sensors?.map((s) => s.entity_id) ?? [];
  const vents = room.vents?.map((v) => v.entity_id) ?? [];
  const presence = room.presence_sensors?.map((p) => p.entity_id) ?? [];
  // What the room cannot do while it has none of this kind of device.
  const note =
    kind === "temps" && sensors.length === 0
      ? NO_TEMP_SENSORS
      : kind === "vents" && vents.length === 0
        ? NO_VENTS
        : kind === "occupancy" && presence.length === 0
          ? NO_OCCUPANCY
          : null;

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

  const askToRemove = (which: "sensor" | "presence") => async (id: string) => {
    setConfirmTarget({ kind: which, id });
  };

  const doRemoveConfirmedEntity = async () => {
    if (!confirmTarget) return;
    const { kind: which, id } = confirmTarget;
    setConfirmTarget(null);
    if (which === "sensor") {
      await wrap("Removing sensor…", (id) => removeSensor(room.id, id))(id);
    } else {
      await wrap("Removing sensor…", (id) => removePresence(room.id, id))(id);
    }
  };

  const title = `${DEVICE_TITLES[kind]} in ${room.name}`;
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="room-devices"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal room-devices">
        <div className="edit-zone-head">
          <div className="modal-title">{title}</div>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>

        {note && <p className="field-help">{note}</p>}

        {busy && (
          <div className="loading" style={{ padding: ".5rem 0", marginBottom: ".5rem" }}>
            <div className="spinner" /> {busy}
          </div>
        )}

        {kind === "vents" && (
          <VentTable
            roomId={room.id}
            roomName={room.name}
            vents={room.vents ?? []}
            onChanged={refresh}
          />
        )}
        {kind === "temps" && (
          <EntitySection
            title="Temperature Sensors"
            description="The room's temperature is the average of these. Add every temperature sensor in the room."
            icon="🌡"
            items={sensors}
            domain="sensor"
            kind="temperature"
            roomName={room.name}
            pickerPlaceholder="Search temperature sensors…"
            emptyHint="No sensors added yet — search above to add one."
            onAdd={wrap("Adding sensor…", (id) => addSensor(room.id, id))}
            onRemove={askToRemove("sensor")}
          />
        )}
        {kind === "doors" && (
          <DoorsWindowsEditor
            roomId={room.id}
            roomName={room.name}
            contacts={contacts}
            onChanged={(all) => onContactsChanged?.(all)}
          />
        )}
        {kind === "occupancy" && (
          <EntitySection
            title="Occupancy Sensors"
            description="When any sensor here detects motion, the room activates at the presence-triggered temperature and stays active for the configured holdover period (reset on each detection)."
            icon="🚶"
            items={presence}
            domain="binary_sensor"
            kind="presence"
            roomName={room.name}
            pickerPlaceholder="Search occupancy and motion sensors…"
            emptyHint="No occupancy sensors added — the room will only activate via schedules."
            onAdd={wrap("Adding sensor…", (id: string) => addPresence(room.id, id))}
            onRemove={askToRemove("presence")}
          />
        )}
        {kind === "shades" &&
          (shades ? (
            <>
              <RoomShades room={room} data={shades} onData={onShadesChanged} />
              <p className="field-help">
                How shades react to the sun is set in Smart Control, under Shades.
              </p>
            </>
          ) : (
            <p className="form-error">Could not load shades.</p>
          ))}

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
  room,
  empty,
  items,
  onOpen,
}: {
  title: string;
  room: string;
  empty: string;
  items: {
    id: string;
    name: string;
    value: string;
    tone?: string;
    tag?: string;
    /** Shown as a coloured dot before the name in place of the value's words. */
    dot?: "on" | "off";
  }[];
  onOpen: () => void;
}) {
  // The whole box is the way in: it opens this kind of device for this room.
  return (
    <button
      type="button"
      className="device-section"
      aria-label={`${title} in ${room}`}
      title={`Add, change or remove ${title.toLowerCase()} in ${room}`}
      onClick={onOpen}
    >
      <span className="device-section-title">
        {title}
        <span className="device-count">{items.length}</span>
      </span>
      {items.length === 0 ? (
        <span className="device-empty">{empty}</span>
      ) : (
        <span className="device-list">
          {items.map((d) => (
            <span key={d.id} className="device-item" title={d.id}>
              <span className="device-name">
                {d.dot && <span className={`device-dot device-dot-${d.dot}`} title={d.value} />}
                {withoutRoom(d.name, room)}
                {d.dot && <span className="sr-only">{`: ${d.value}`}</span>}
              </span>
              <span className={`device-value${d.tone ? ` device-${d.tone}` : ""}`}>
                {!d.dot && d.value}
                {d.tag && <span className="device-tag">{d.tag}</span>}
              </span>
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/** A device's name without the room's own name in front: "Kitchen Motion" in Kitchen is "Motion". */
export function withoutRoom(name: string, room: string): string {
  const lead = room.trim().toLowerCase();
  if (lead && name.toLowerCase().startsWith(lead)) {
    const rest = name.slice(lead.length).replace(/^[\s\-–—:,.'’s]+/, "");
    if (rest) return rest[0].toUpperCase() + rest.slice(1);
  }
  return name;
}

function friendly(state: EntityState | null | undefined, id: string): string {
  const name = state?.attributes?.friendly_name;
  return typeof name === "string" && name ? name : id;
}

/** A room's hardware: one box per kind of device, each opening that kind. */
function RoomCard({
  room,
  contacts,
  shades,
  staleSensors,
  onOpen,
  onEdit,
}: {
  room: Room;
  contacts: ContactSensor[];
  shades: Shades["shades"];
  staleSensors: StaleSensor[];
  onOpen: (kind: DeviceKind) => void;
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
    // Entity ids are re-read when the room or its devices change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, [...sensorIds, ...ventIds, ...presenceIds].join()]);

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
      // A green or grey dot says occupied or clear in less room than the word.
      dot: st === "on" ? ("on" as const) : st === "off" ? ("off" as const) : undefined,
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
        <DeviceSection
          title="Smart Vents"
          room={room.name}
          empty="No vents"
          items={vents}
          onOpen={() => onOpen("vents")}
        />
        <DeviceSection
          title="Temperature Sensors"
          room={room.name}
          empty="No sensors"
          items={temps}
          onOpen={() => onOpen("temps")}
        />
        <DeviceSection
          title="Doors & Windows"
          room={room.name}
          empty="None"
          items={doors}
          onOpen={() => onOpen("doors")}
        />
        <DeviceSection
          title="Occupancy Sensors"
          room={room.name}
          empty="None"
          items={occupancy}
          onOpen={() => onOpen("occupancy")}
        />
        <DeviceSection
          title="Shades"
          room={room.name}
          empty="None"
          items={shades.map((sh) => ({
            id: sh.entity_id,
            name: sh.name,
            value: { open: "Open", closed: "Closed", moving: "Moving", unknown: "Unknown" }[
              sh.state
            ],
          }))}
          onOpen={() => onOpen("shades")}
        />
      </div>
      <div className="room-card-actions">
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
  const [devices, setDevices] = useState<{ roomId: string; kind: DeviceKind } | null>(null);
  const [shades, setShades] = useState<Shades | null>(null);
  const [settings, setSettings] = useState<{ room: Room | null; zoneId?: string } | null>(null);
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

  const loadShades = async () => {
    try {
      setShades(await getShades());
    } catch {
      setShades(null);
    }
  };

  const load = async () => {
    const [list, tcs] = await Promise.all([getRooms(), getThermostats()]);
    const detailed = await Promise.all(list.map((r) => getRoom(r.id)));
    setRooms(detailed);
    setThermostats(tcs);
    setZoneIds(new Set(tcs.map((t) => t.thermostat_entity_id)));
    setLoading(false);
    await Promise.all([refreshSensorHealth(), loadContacts(), loadShades()]);
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
    const { room: editing, zoneId } = settings;
    return (
      <RoomSettings
        room={editing}
        zoneId={zoneId}
        rooms={rooms}
        thermostats={thermostats}
        onCancel={() => setSettings(null)}
        onDeleted={async () => {
          setSettings(null);
          setReloadKey((k) => k + 1);
          await load();
        }}
        onSaved={async () => {
          setSettings(null);
          setReloadKey((k) => k + 1);
          await load();
        }}
      />
    );
  }

  const card = (room: Room) => (
    <RoomCard
      key={room.id}
      room={room}
      contacts={contacts.filter((c) => c.room_id === room.id)}
      shades={(shades?.shades ?? []).filter((sh) => sh.room_id === room.id)}
      staleSensors={staleByRoom[room.id] ?? []}
      onOpen={(kind) => setDevices({ roomId: room.id, kind })}
      onEdit={() => setSettings({ room })}
    />
  );
  const loose = rooms.filter((r) => !zoneIds.has(r.thermostat_entity_id));
  const deviceRoom = devices && rooms.find((r) => r.id === devices.roomId);

  return (
    <div>
      <Zones
        reloadKey={reloadKey}
        onChanged={() => void load()}
        renderRooms={(zoneId) => {
          const zoneRooms = rooms.filter((r) => r.thermostat_entity_id === zoneId);
          const zoneName =
            thermostats.find((t) => t.thermostat_entity_id === zoneId)?.name || zoneId;
          return (
            <>
              {zoneRooms.length === 0 && (
                <p className="field-help">
                  This zone has no rooms. It cannot be controlled until at least one room is added.
                </p>
              )}
              <div className="card-grid">
                {zoneRooms.map(card)}
                <button
                  type="button"
                  className="add-tile"
                  aria-label={`Add Room to ${zoneName}`}
                  onClick={() => setSettings({ room: null, zoneId })}
                >
                  <span className="add-tile-plus" aria-hidden="true">
                    +
                  </span>
                  Add Room
                </button>
              </div>
            </>
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
      {devices && deviceRoom && (
        <RoomDeviceModal
          room={deviceRoom}
          kind={devices.kind}
          contacts={contacts.filter((c) => c.room_id === deviceRoom.id)}
          shades={shades}
          onContactsChanged={setContacts}
          onShadesChanged={setShades}
          onRoomUpdated={(updated) =>
            setRooms((all) => all.map((r) => (r.id === updated.id ? updated : r)))
          }
          onClose={() => {
            setDevices(null);
            void refreshSensorHealth();
          }}
        />
      )}
    </div>
  );
}
