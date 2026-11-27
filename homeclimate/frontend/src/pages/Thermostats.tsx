import EntityName, { entityName } from "../components/EntityName";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  getThermostats,
  getRooms,
  createThermostat,
  updateThermostat,
  deleteThermostat,
  getSensorStaleness,
  setSensorStaleness,
  type Room,
  type ThermostatConfig,
} from "../api";
import EntityPicker from "../components/EntityPicker";
import ConfirmDialog from "../components/ConfirmDialog";
import EcoSuspendModal from "../components/EcoSuspendModal";
import AirflowConfigBanner from "../components/AirflowConfigBanner";
import OutsideTempPicker from "../components/OutsideTempPicker";
import { ECO_NUMERIC_FIELDS } from "../eco";
import { useTimeZone, useUnit } from "../contexts";
import { onStateChanged } from "../stateEvents";

// ---------------------------------------------------------------------------
// Safety settings fields (numerical config)
// ---------------------------------------------------------------------------

/** The numeric settings under Advanced Options, in the groups they are shown in. */
const ADVANCED_FIELDS: {
  key: keyof ThermostatConfig;
  label: string;
  help: string;
  step: string;
  min: string;
  kind: "delta_temp" | "other";
  unit?: string;
  group: "comfort" | "protection" | "airflow" | "safeguards";
}[] = [
  {
    key: "deadband",
    label: "Room counts as at target within",
    help: "How close to its target a room has to be. 0 means an exact match.",
    step: "0.1",
    min: "0",
    kind: "delta_temp",
    group: "comfort",
  },
  {
    key: "overshoot_delta",
    label: "Run past the target by",
    help: "How far past the target the thermostat is set, to keep the equipment running.",
    step: "0.5",
    min: "0",
    kind: "delta_temp",
    group: "comfort",
  },
  {
    key: "min_cycle_runtime_min",
    label: "Run at least",
    help: "Once heating or cooling starts it runs at least this long, which protects the equipment. 0 turns this off.",
    step: "1",
    min: "0",
    kind: "other",
    unit: "min",
    group: "protection",
  },
  {
    key: "min_cycle_offtime_min",
    label: "Rest between runs at least",
    help: "After heating or cooling stops it waits at least this long before starting again. 0 turns this off.",
    step: "1",
    min: "0",
    kind: "other",
    unit: "min",
    group: "protection",
  },
  {
    key: "max_vent_closed_min",
    label: "Reopen a closed vent after",
    help: "A vent closed this long is opened again. 0 turns this off.",
    step: "1",
    min: "0",
    kind: "other",
    unit: "min",
    group: "airflow",
  },
  {
    key: "cycle_timeout_hours",
    label: "End a run that lasts longer than",
    help: "A run still going after this long is stopped.",
    step: "0.5",
    min: "0.5",
    kind: "other",
    unit: "hr",
    group: "safeguards",
  },
  {
    key: "unavailable_abort_after_min",
    label: "End a run if the thermostat goes quiet for",
    help: "The run is ended and every vent is opened. 0 turns this off.",
    step: "1",
    min: "0",
    kind: "other",
    unit: "min",
    group: "safeguards",
  },
];

// ---------------------------------------------------------------------------
// Add thermostat modal
// ---------------------------------------------------------------------------

// Welcome home (Issue #728) — the backend's defaults and bounds, named once so
// the inputs, the validation and the backend cannot drift apart silently.
const WELCOME_HOME_DEFAULT_LEAD_MIN = 60;
const WELCOME_HOME_DEFAULT_HOURS = 1;
/** The same rules as the API's write boundary, so Save fails fast and clearly. */
function welcomeHomeError(form: Partial<ThermostatConfig>): string {
  const lead = form.welcome_home_lead_min ?? WELCOME_HOME_DEFAULT_LEAD_MIN;
  const hours = form.welcome_home_hours ?? WELCOME_HOME_DEFAULT_HOURS;
  if (!Number.isInteger(lead) || lead < 0 || lead > 240) {
    return "Welcome home start must be a whole number of minutes from 0 to 240";
  }
  if (!Number.isFinite(hours) || hours < 0.25 || hours > 12) {
    return "Welcome home duration must be between 0.25 and 12 hours";
  }
  return "";
}

export function AddThermostatModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (tc: ThermostatConfig) => void;
}) {
  const [entityId, setEntityId] = useState("");
  const [name, setName] = useState("");
  const [totalVentsCount, setTotalVentsCount] = useState("");
  const [hasBypassDamper, setHasBypassDamper] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!entityId) {
      setError("Select a thermostat entity");
      return;
    }
    if (!name.trim()) {
      setError("Friendly name is required");
      return;
    }
    const parsedTotal = parseInt(totalVentsCount, 10);
    if (!Number.isFinite(parsedTotal) || parsedTotal < 1) {
      setError("Total vent count is required — a positive integer");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const tc = await createThermostat({
        thermostat_entity_id: entityId,
        name: name.trim(),
        total_vents_count: parsedTotal,
        has_bypass_damper: hasBypassDamper,
      });
      onSave(tc);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">Register Thermostat</div>
        {error && (
          <div className="badge badge-red" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        <div className="form-group">
          <label className="form-label">HA Thermostat Entity *</label>
          <EntityPicker domain="climate" placeholder="Search thermostats…" onSelect={setEntityId} />
          {entityId && (
            <div className="tag" style={{ marginTop: ".4rem" }}>
              ✓ <EntityName id={entityId} />
              <button className="tag-remove" onClick={() => setEntityId("")}>
                ×
              </button>
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="add-thermo-name">
            Friendly name *
          </label>
          <input
            id="add-thermo-name"
            className="form-control"
            placeholder="e.g. Upstairs HVAC"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <div className="form-hint">
            This name appears on the Dashboard and in Room configuration.
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="add-thermo-total-vents">
            Total vent count on this thermostat *
          </label>
          <input
            id="add-thermo-total-vents"
            className="form-control"
            type="number"
            min="1"
            step="1"
            placeholder="e.g. 12"
            value={totalVentsCount}
            onChange={(e) => setTotalVentsCount(e.target.value)}
          />
          <div className="form-hint">
            Count every air vent this thermostat feeds, smart or not. HomeClimate keeps enough of
            them open to protect the equipment.
          </div>
        </div>

        <div className="form-group">
          <label
            htmlFor="add-thermo-bypass-damper"
            style={{ display: "flex", alignItems: "center", gap: ".5rem", cursor: "pointer" }}
          >
            <input
              id="add-thermo-bypass-damper"
              type="checkbox"
              checked={hasBypassDamper}
              onChange={(e) => setHasBypassDamper(e.target.checked)}
            />
            <span>I have a bypass damper</span>
          </label>
          <div className="form-hint">
            A bypass damper lets extra air escape when vents close. Most homes do not have one.
            Ticking this turns off the limit on closed vents.
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Register"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-thermostat card (name, default_temp, safety settings)
// ---------------------------------------------------------------------------

/**
 * Derived-form keys the form does NOT own, so a change in them must not
 * re-derive the form and discard what the user has typed.
 *
 * This is a decision record, not a denylist to pad — the same shape as
 * `ROOM_EXCLUDED_FIELDS` in `backend/mqtt/registry.py`. A key earns a place
 * here only if the card renders it from `config` rather than from `form` AND
 * the REST write boundary refuses it, so letting the form's copy go stale is
 * unobservable.
 *
 * - `eco_suspend_until`: scheduler-owned and READ-ONLY (see `ThermostatConfig`
 *   — "Never send this on config saves"). The card header reads it straight
 *   off `config`, and the PUT allowlist drops it. Without this exclusion,
 *   suspending Eco from the header of the very card you are editing refetches,
 *   moves this one field, and throws the edit away — #597's symptom on its
 *   most reachable path, since that button lives inside the card (#500).
 * - `eco_mode_enabled` and the Eco numbers: edited in Smart Control, Eco Mode,
 *   not on this card. The header reads `eco_mode_enabled` off `config`, and
 *   `ownedFields` keeps every one of them out of this card's save.
 */
const FORM_UNOWNED_FIELDS = new Set<string>([
  "eco_suspend_until",
  "eco_mode_enabled",
  ...ECO_NUMERIC_FIELDS.map((f) => f.key),
]);

/**
 * The card's save payload: the form without the fields it does not own.
 *
 * The Eco fields are the reason this exists. The form spreads `...cfg`, so it
 * carries them in STORAGE units (°F), untouched. Sending them back would have
 * the write boundary convert them again on a Celsius house (#231).
 */
function ownedFields(form: ThermostatConfig): Partial<ThermostatConfig> {
  return Object.fromEntries(
    Object.entries(form).filter(([key]) => !FORM_UNOWNED_FIELDS.has(key))
  ) as Partial<ThermostatConfig>;
}

/**
 * Content equality for two derived thermostat forms (#597).
 *
 * Both operands always come from `toDisplayForm`, which spreads `...cfg`, so
 * every value is a scalar (string | number | boolean | null) and comparing the
 * union of both key sets is an exact comparison — a field added to
 * `ThermostatConfig` joins it automatically, with no manifest to drift.
 *
 * Keep every field scalar. A nested value would be spread by reference, so a
 * refetch — which rebuilds `config` from a fresh JSON parse — would hand it a
 * new reference every time, `Object.is` would report "changed" on every
 * refetch, and the form would be re-derived out from under whatever the user
 * had typed. That is not a safe degradation, it is #597 again: over-deriving
 * IS the bug this guard exists to stop. If a nested field ever becomes
 * necessary, compare it by value here rather than letting it fall through.
 *
 * `Object.is`, not `===`, on purpose: this decides whether to set state during
 * render, and `NaN !== NaN` would make a NaN-valued field re-derive forever
 * ("Too many re-renders"). `Object.is(NaN, NaN)` is true.
 */
function sameDerivedForm(a: ThermostatConfig, b: ThermostatConfig): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (FORM_UNOWNED_FIELDS.has(key)) continue;
    const k = key as keyof ThermostatConfig;
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

export function ThermostatCard({
  config,
  onDeleted,
  onSaved,
  onSuspendEco,
  zoneHasRoomOptIn = false,
  embedded = false,
  onClose,
}: {
  config: ThermostatConfig;
  /** Shown inside My Home's Edit Zone dialog, which names the zone itself:
   *  no card frame and no title of its own. */
  embedded?: boolean;
  /** Embedded: the dialog's way out, beside Save. */
  onClose?: () => void;
  onDeleted: () => void;
  onSaved?: (updated: ThermostatConfig) => void;
  onSuspendEco?: () => void;
  // Eco Suspend visibility (#500): true when a room under this thermostat has
  // an explicit Eco opt-in, which puts Eco in play even with the thermostat
  // toggle off.
  zoneHasRoomOptIn?: boolean;
}) {
  const { unitLabel, toDisplay, toDisplayDelta } = useUnit();
  const tz = useTimeZone();
  // Form state holds temperatures in DISPLAY units (°C or °F as the user
  // sees them). The backend converts to storage (°F) on the write boundary
  // via _to_f / _delta_to_f. See CLAUDE.md "Temperature unit system".
  // Field names like `cooling_lockout_below_f` describe storage semantics;
  // the value here is whatever unit the user is currently typing in.
  const toDisplayForm = (cfg: ThermostatConfig): ThermostatConfig => ({
    ...cfg,
    default_temp: cfg.default_temp != null ? toDisplay(cfg.default_temp) : null,
    min_setpoint: toDisplay(cfg.min_setpoint),
    max_setpoint: toDisplay(cfg.max_setpoint),
    deadband: toDisplayDelta(cfg.deadband),
    overshoot_delta: toDisplayDelta(cfg.overshoot_delta),
    cooling_lockout_below_f:
      cfg.cooling_lockout_below_f != null ? toDisplay(cfg.cooling_lockout_below_f) : null,
  });
  // Re-derive the form when the derived CONTENT changes: the unit context
  // resolving (App fetches /api/settings async on mount — if /api/thermostats
  // wins that race, this card mounts under the default °F context and the first
  // derivation bakes °F numbers into a form about to be labeled °C, so any save
  // would round-trip the wrong value — #231 follow-up), or a config whose values
  // actually moved (the echo a save feeds back through onSaved, #293).
  //
  // Two properties are load-bearing, both from #597:
  //
  //  1. CONTENT, not object identity. `load()` hands every surviving card a
  //     brand-new config object after any refetch — removing another
  //     thermostat, registering one, suspending Eco. Re-deriving on identity
  //     silently discarded whatever the user had typed into the other cards.
  //     Same class of bug as #293, one path over.
  //
  //  2. During RENDER, not in a passive effect. React commits the DOM and then
  //     schedules passive effects as a separate host task, so a reset queued in
  //     useEffect can flush AFTER an input's onChange has queued its own update
  //     — React drains pending passive effects at the top of the next render
  //     pass. `setForm(<plain object>)` then replaces the queued edit no matter
  //     how that edit was written, functional updater included: the form
  //     silently reverted to its initial values and the next Save posted them.
  //     This is React's "adjusting state when a prop changes". The baseline is
  //     a state cell rather than a ref because writing a ref during render is
  //     impure — React's own rule — and a state cell is rolled back with a
  //     discarded render pass, which StrictMode (main.tsx) produces on every
  //     render. Measured: a ref baseline behaves identically today, so this is
  //     about staying inside the rules, not about a difference you can observe.
  //
  //     The comparison must be by CONTENT for a second reason: `derivedForm` is
  //     a fresh object every render, so an identity check would set state on
  //     every pass and React would throw "Too many re-renders" (verified).
  //
  // `lastDerivedForm` is an immutable snapshot and aliases `form` right after a
  // derive — never mutate either in place. Every edit below goes through
  // `setForm((f) => ({ ...f, … }))`; an in-place write would corrupt the
  // baseline this comparison reads, and a genuine unit flip would then be
  // skipped, putting °F numbers under a °C label (#231) with no test failing.
  const derivedForm = toDisplayForm(config);
  const [form, setForm] = useState<ThermostatConfig>(derivedForm);
  const [lastDerivedForm, setLastDerivedForm] = useState<ThermostatConfig>(derivedForm);
  if (!sameDerivedForm(derivedForm, lastDerivedForm)) {
    setLastDerivedForm(derivedForm);
    setForm(derivedForm);
  }
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Track the "Saved!" reset timer so it can be cancelled on unmount. Without
  // this, a save that completes just before the card unmounts (e.g. a test
  // tearing down jsdom) fires setSaved() after teardown — "window is not
  // defined" in CI. Clearing on unmount keeps the timer from outliving the
  // component.
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const save = async () => {
    if (!form.name.trim()) {
      setError("Friendly name is required");
      return;
    }
    if (form.min_setpoint >= form.max_setpoint) {
      setError("Min setpoint must be less than max setpoint");
      return;
    }
    const welcomeError = welcomeHomeError(form);
    if (welcomeError) {
      setError(welcomeError);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const updated = await updateThermostat(config.thermostat_entity_id, ownedFields(form));
      // Refresh the parent's baseline (°F storage units, as returned by the API)
      // so a later form reset re-derives from the just-saved values — never the
      // stale page-load config that would silently regress the DB on re-save.
      // (Issue #293)
      onSaved?.(updated);
      setSaved(true);
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setConfirmRemove(false);
    try {
      await deleteThermostat(config.thermostat_entity_id, true);
      onDeleted();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const advancedRows = (group: (typeof ADVANCED_FIELDS)[number]["group"]) =>
    ADVANCED_FIELDS.filter((f) => f.group === group).map(
      ({ key, label, help, step, min, kind, unit }) => (
        <div className="advanced-row" key={key}>
          <label htmlFor={`thermo-${config.thermostat_entity_id}-${key}`} title={help}>
            {label}
          </label>
          <span className="minutes-field">
            {/* Temperatures in `form` are already in display units; the backend converts. */}
            <input
              id={`thermo-${config.thermostat_entity_id}-${key}`}
              className="form-control minutes-input"
              type="number"
              step={step}
              min={min}
              value={(form[key] as number) ?? ""}
              onChange={(e) => {
                const v = parseFloat(e.target.value) || 0;
                setForm((f) => ({ ...f, [key]: v }));
              }}
            />
            <span className="minutes-unit">{kind === "delta_temp" ? unitLabel : unit}</span>
          </span>
        </div>
      )
    );

  return (
    <div className={embedded ? "thermostat-embedded" : "card"} style={{ marginBottom: "1rem" }}>
      {/* Header */}
      <div className="flex-between" style={{ marginBottom: "1rem" }}>
        {embedded ? (
          <span />
        ) : (
          <div>
            <div className="card-title" style={{ marginBottom: ".15rem" }}>
              {form.name || <span className="text-muted">(unnamed)</span>}
            </div>
            <EntityName id={config.thermostat_entity_id} className="text-muted text-sm" />
          </div>
        )}
        <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
          {/* Eco Suspend (#500): top-of-card control, present only when Eco is
              in play for this thermostat — enabled on the thermostat, opted
              into by one of its rooms, or already suspended. */}
          {onSuspendEco &&
            (config.eco_mode_enabled || config.eco_suspend_until || zoneHasRoomOptIn) && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={onSuspendEco}
                title={config.eco_suspend_until ? tz.tooltip(config.eco_suspend_until) : undefined}
              >
                🍃{" "}
                {config.eco_suspend_until
                  ? `Eco suspended until ${tz.format(config.eco_suspend_until)}`
                  : "Suspend Eco"}
              </button>
            )}
          {!embedded && (
            <button className="btn btn-danger btn-sm" onClick={() => setConfirmRemove(true)}>
              Delete Zone
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="badge badge-red" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      <div className="sheet-rows">
        <div className="sheet-row">
          <label className="sheet-row-text" htmlFor={`thermo-${config.thermostat_entity_id}-name`}>
            <strong>Name</strong>
          </label>
          <input
            id={`thermo-${config.thermostat_entity_id}-name`}
            className="form-control sheet-name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Upstairs"
          />
        </div>
        <div className="sheet-row">
          <label
            className="sheet-row-text"
            htmlFor={`thermo-${config.thermostat_entity_id}-total-vents`}
          >
            <strong>Number of Vents</strong>
            <p className="rule-help">Every register in this zone, smart or not.</p>
          </label>
          <input
            id={`thermo-${config.thermostat_entity_id}-total-vents`}
            className="form-control minutes-input"
            type="number"
            min="1"
            step="1"
            value={form.total_vents_count ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              setForm((f) => ({
                ...f,
                total_vents_count: raw === "" ? null : Math.max(1, parseInt(raw, 10) || 0),
              }));
            }}
          />
        </div>
        <div className="sheet-row">
          <div className="sheet-row-text">
            <strong>Temperature Limits</strong>
            <p className="rule-help">The thermostat is never set outside these.</p>
          </div>
          <span className="minutes-field">
            {(["min_setpoint", "max_setpoint"] as const).map((key) => (
              <Fragment key={key}>
                {key === "max_setpoint" && <span className="minutes-unit">to</span>}
                <input
                  id={`thermo-${config.thermostat_entity_id}-${key}`}
                  className="form-control minutes-input"
                  type="number"
                  step="0.5"
                  min="0"
                  aria-label={`${key === "min_setpoint" ? "Lowest" : "Highest"} temperature (${unitLabel})`}
                  value={form[key] ?? ""}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value) || 0;
                    setForm((f) => ({ ...f, [key]: v }));
                  }}
                />
              </Fragment>
            ))}
            <span className="minutes-unit">{unitLabel}</span>
          </span>
        </div>
        <div className="sheet-row">
          <label
            className="sheet-row-text"
            htmlFor={`thermo-${config.thermostat_entity_id}-default_temp`}
          >
            <strong>Occupied Temperature</strong>
            <p className="rule-help">
              Used when someone is in a room that has no temperature of its own.
            </p>
          </label>
          <span className="minutes-field">
            <input
              id={`thermo-${config.thermostat_entity_id}-default_temp`}
              className="form-control minutes-input"
              type="number"
              step="0.5"
              value={form.default_temp ?? ""}
              placeholder={String(Math.round(toDisplay(72)))}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  default_temp: e.target.value ? parseFloat(e.target.value) : null,
                }))
              }
            />
            <span className="minutes-unit">{unitLabel}</span>
          </span>
        </div>
      </div>

      <details className="advanced-box">
        <summary>
          <strong>Advanced Options</strong>
          <span>You don&rsquo;t need to change these unless you want to.</span>
        </summary>
        <div className="advanced-groups">
          <div>
            <span className="advanced-group-title">Comfort</span>
            {advancedRows("comfort")}
          </div>
          <div>
            <span className="advanced-group-title">Equipment Protection</span>
            {advancedRows("protection")}
            {/* Overflow conditioning during the minimum-runtime hold (Issue
                #237): only meaningful with a minimum run time. */}
            <label
              className="advanced-row"
              htmlFor={`thermo-${config.thermostat_entity_id}-overflow`}
            >
              <span title="If rooms reach their target before the equipment may stop, the extra air goes to other rooms.">
                Send spare air to other rooms
              </span>
              <input
                id={`thermo-${config.thermostat_entity_id}-overflow`}
                className="switch"
                type="checkbox"
                role="switch"
                checked={form.overflow_during_min_runtime ?? true}
                disabled={(form.min_cycle_runtime_min ?? 0) <= 0}
                onChange={(e) =>
                  setForm((f) => ({ ...f, overflow_during_min_runtime: e.target.checked }))
                }
              />
            </label>
          </div>
          <div>
            <span className="advanced-group-title">Airflow</span>
            {/* Airflow floor / dead-head protection (Issue #213). */}
            <div className="advanced-row">
              <label
                htmlFor={`thermo-${config.thermostat_entity_id}-fraction`}
                title="Closing too many vents at once can damage the equipment."
              >
                Keep this share of vents open
              </label>
              <span className="minutes-field">
                <input
                  id={`thermo-${config.thermostat_entity_id}-fraction`}
                  className="advanced-range"
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={form.min_open_vents_fraction ?? 0.333}
                  disabled={form.has_bypass_damper}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, min_open_vents_fraction: parseFloat(e.target.value) }))
                  }
                />
                <strong>{`${Math.round((form.min_open_vents_fraction ?? 0.333) * 100)}%`}</strong>
              </span>
            </div>
            <label
              className="advanced-row"
              htmlFor={`thermo-${config.thermostat_entity_id}-bypass-damper`}
            >
              <span title="A bypass damper lets extra air escape when vents close, so the share above is not enforced.">
                Bypass damper installed
              </span>
              <input
                id={`thermo-${config.thermostat_entity_id}-bypass-damper`}
                className="switch"
                type="checkbox"
                role="switch"
                checked={form.has_bypass_damper}
                onChange={(e) => setForm((f) => ({ ...f, has_bypass_damper: e.target.checked }))}
              />
            </label>
            {advancedRows("airflow")}
          </div>
          <div>
            <span className="advanced-group-title">Safeguards</span>
            {/* Outdoor-temperature cooling lockout (Issue #209). Blank is off. */}
            <div className="advanced-row">
              <label
                htmlFor={`thermo-${config.thermostat_entity_id}-cooling-lockout`}
                title="Cooling does not run when it is colder than this outside. It needs an outside sensor (My Home, Outside)."
              >
                No cooling when outside is below
              </label>
              <span className="minutes-field">
                <input
                  id={`thermo-${config.thermostat_entity_id}-cooling-lockout`}
                  className="form-control minutes-input"
                  type="number"
                  step="0.5"
                  placeholder="Off"
                  value={form.cooling_lockout_below_f ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setForm((f) => ({
                      ...f,
                      cooling_lockout_below_f: raw === "" ? null : parseFloat(raw) || 0,
                    }));
                  }}
                />
                <span className="minutes-unit">{unitLabel}</span>
              </span>
            </div>
            {advancedRows("safeguards")}
            {/* Capped by the longest run, so it is not one of the plain rows. */}
            <div className="advanced-row">
              <label
                htmlFor={`thermo-${config.thermostat_entity_id}-drift`}
                title="How often HomeClimate checks that vents and the thermostat are still set the way it left them. 0 turns this off."
              >
                Re-check vents and thermostat every
              </label>
              <span className="minutes-field">
                <input
                  id={`thermo-${config.thermostat_entity_id}-drift`}
                  className="form-control minutes-input"
                  type="number"
                  step="1"
                  min="0"
                  max={Math.floor(form.cycle_timeout_hours * 60)}
                  value={form.reconciliation_interval_min ?? 0}
                  onChange={(e) => {
                    const val = parseInt(e.target.value) || 0;
                    const maxVal = Math.floor(form.cycle_timeout_hours * 60);
                    setForm((f) => ({ ...f, reconciliation_interval_min: Math.min(val, maxVal) }));
                  }}
                />
                <span className="minutes-unit">min</span>
              </span>
            </div>
          </div>
          <div>
            <span className="advanced-group-title">While You Are Away</span>
            <label
              className="advanced-row"
              htmlFor={`thermo-${config.thermostat_entity_id}-vacation-safety`}
            >
              <span
                title={`On vacation a room that gets colder than ${form.min_setpoint}${unitLabel} or warmer than ${form.max_setpoint}${unitLabel} gets heating or cooling.`}
              >
                Keep each room inside the limits
              </span>
              <input
                id={`thermo-${config.thermostat_entity_id}-vacation-safety`}
                className="switch"
                type="checkbox"
                role="switch"
                checked={form.vacation_safety_cycles ?? true}
                onChange={(e) =>
                  setForm((f) => ({ ...f, vacation_safety_cycles: e.target.checked }))
                }
              />
            </label>
            {/* Welcome home before a vacation return (Issue #728). */}
            <div data-testid="welcome-home-group">
              <label
                className="advanced-row"
                htmlFor={`thermo-${config.thermostat_entity_id}-welcome-home`}
              >
                <span title="Before you get back, each room is brought to its occupied temperature, so the house is comfortable when you walk in.">
                  Get the house ready before I return
                </span>
                <input
                  id={`thermo-${config.thermostat_entity_id}-welcome-home`}
                  className="switch"
                  type="checkbox"
                  role="switch"
                  checked={form.welcome_home_enabled ?? true}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, welcome_home_enabled: e.target.checked }))
                  }
                />
              </label>
              <div className="advanced-row">
                <label htmlFor={`thermo-${config.thermostat_entity_id}-welcome-lead`}>
                  Start this long before I return
                </label>
                <span className="minutes-field">
                  <input
                    id={`thermo-${config.thermostat_entity_id}-welcome-lead`}
                    className="form-control minutes-input"
                    type="number"
                    min={0}
                    max={240}
                    step={5}
                    value={form.welcome_home_lead_min ?? WELCOME_HOME_DEFAULT_LEAD_MIN}
                    disabled={!(form.welcome_home_enabled ?? true)}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, welcome_home_lead_min: parseFloat(e.target.value) }))
                    }
                  />
                  <span className="minutes-unit">min</span>
                </span>
              </div>
              <div className="advanced-row">
                <label htmlFor={`thermo-${config.thermostat_entity_id}-welcome-hours`}>
                  Keep rooms occupied for
                </label>
                <span className="minutes-field">
                  <input
                    id={`thermo-${config.thermostat_entity_id}-welcome-hours`}
                    className="form-control minutes-input"
                    type="number"
                    min={0.25}
                    max={12}
                    step={0.25}
                    value={form.welcome_home_hours ?? WELCOME_HOME_DEFAULT_HOURS}
                    disabled={!(form.welcome_home_enabled ?? true)}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, welcome_home_hours: parseFloat(e.target.value) }))
                    }
                  />
                  <span className="minutes-unit">hr</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </details>

      <div className="zone-editor-actions">
        {saved && <span className="badge badge-green">Saved!</span>}
        <span className="spacer" />
        {onClose && (
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        )}
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>

      {confirmRemove && (
        <ConfirmDialog
          title="Delete zone?"
          message={`Delete the zone "${form.name || entityName(config.thermostat_entity_id)}" and all of its rooms? This cannot be undone.`}
          confirmLabel="Delete Zone"
          onConfirm={() => void remove()}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sensor-staleness threshold (Issue #211)
// ---------------------------------------------------------------------------

// Mirrors SENSOR_STALE_AFTER_MIN in backend/engine/cycle_engine.py, which
// routes.py also serves when the setting was never written. Named rather than
// inlined so the seed and the warning copy below cannot drift apart from each
// other — the failure path is the only place the seed is ever visible, so a
// divergence would not fail any test.
const SENSOR_STALE_DEFAULT_MIN = 30;

export function SensorStalenessCard() {
  // Seeded with the backend's own default so the input never renders from
  // `null`, and gated on the mount fetch so a late resolve cannot land on top
  // of what the operator is typing (#600). This is CLAUDE.md pitfall #9's
  // mount-fetch trap; `RetentionSettings` in Logs.tsx is the precedent.
  const [value, setValue] = useState(SENSOR_STALE_DEFAULT_MIN);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Separate from `status` on purpose: `save()` clears `status`, and a warning
  // that the shown number is a fabricated default must NOT be erased by the
  // very Save it exists to warn about.
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    // `cancelled` is not ceremony: <StrictMode> (main.tsx) runs setup → cleanup
    // → setup, so without it TWO GETs are in flight and the loser writes into a
    // card that the winner already made interactive — reopening exactly the
    // race this component is being fixed for, one response later.
    let cancelled = false;
    getSensorStaleness()
      .then((s) => {
        if (cancelled) return;
        setValue(s.stale_after_min);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const r = await setSensorStaleness(value);
      setValue(r.stale_after_min);
      // The field now holds what the server holds, so the "this is a default"
      // warning has stopped being true.
      setLoadFailed(false);
      setStatus({ ok: true, msg: "Saved" });
    } catch (err) {
      setStatus({ ok: false, msg: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div className="card-title">Sensor-staleness threshold</div>
      <div className="form-hint" style={{ marginBottom: ".75rem" }}>
        A sensor that has not reported for this long is left out of its room&apos;s temperature. 30
        minutes suits most sensors.
      </div>
      {loading ? (
        // No input exists until the GET lands, so there is nothing for a late
        // resolve to overwrite and nothing for a Save to no-op on (#600).
        <div className="loading" style={{ padding: ".5rem 0" }}>
          <div className="spinner" /> Loading current threshold…
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: ".5rem", alignItems: "center" }}>
            <label
              htmlFor="thermostats-sensor-stale-min"
              className="form-label"
              style={{ margin: 0 }}
            >
              Minutes
            </label>
            <input
              id="thermostats-sensor-stale-min"
              className="form-control"
              type="number"
              min={1}
              max={24 * 60}
              step={1}
              value={value}
              onChange={(e) => setValue(parseFloat(e.target.value) || 0)}
              // Disabled while the PUT is in flight for the same reason the
              // button is: `save()` adopts the server's echo, and that write
              // would land on anything typed in the meantime.
              disabled={saving}
              style={{ width: 120 }}
            />
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
              Save
            </button>
          </div>
          {/* On their own line rather than inside the nowrap row above: the load
              warning and a real backend rejection ("stale_after_min must be
              between 1 and 1440 minutes") are both too long to sit next to a
              120px input. Nothing renders here until the operator acts or the
              GET fails, so the settled page is unchanged. */}
          {loadFailed && (
            <div className="text-danger" style={{ marginTop: ".5rem" }}>
              {/* One expression, so this renders as a single text node — a
                  message split across nodes by JSX interpolation cannot be
                  matched by getByText, and the escaped-apostrophe entity JSX
                  would otherwise need renders as ’ rather than '. */}
              {`Couldn't load the saved threshold — showing the ${SENSOR_STALE_DEFAULT_MIN} min default, not your configured value.`}
            </div>
          )}
          {status && (
            <div
              className={status.ok ? "text-success" : "text-danger"}
              style={{ marginTop: ".5rem" }}
            >
              {status.msg}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Thermostats() {
  const [configs, setConfigs] = useState<ThermostatConfig[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  // Eco Suspend modal (#500): null = closed; { thermostat } = open, optionally
  // pre-scoped to the card it was opened from.
  const [ecoSuspendFor, setEcoSuspendFor] = useState<{ thermostat?: string } | null>(null);

  const load = async () => {
    // Rooms are needed for the Eco Suspend visibility rule (#500): a room's
    // explicit Eco opt-in puts Eco in play even when its thermostat has it off.
    const [tc, r] = await Promise.all([getThermostats(), getRooms()]);
    setConfigs(tc);
    setRooms(r);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // The global Eco banner's Manage modal changes suspensions too; keep the
    // per-card "Eco suspended until …" lines in step with it (#678). Safe to
    // refetch under unsaved edits — `eco_suspend_until` is form-unowned, so the
    // cards' content-keyed re-derive leaves the forms alone (#597).
    return onStateChanged("eco-suspend", load);
  }, []);

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" /> Loading thermostats…
      </div>
    );

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Thermostats</div>
          <div className="page-subtitle">
            Register your thermostats here first, then assign rooms to them
          </div>
        </div>
        <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
          {/* Only shown when Eco is in play somewhere: a thermostat has Eco
              enabled, a room has an explicit Eco opt-in, or a suspension is
              already active (#500). */}
          {(configs.some((c) => c.eco_mode_enabled || c.eco_suspend_until) ||
            rooms.some((r) => r.eco_mode_enabled === true)) && (
            <button
              className="btn btn-secondary"
              data-testid="thermostats-eco-suspend-btn"
              onClick={() => setEcoSuspendFor({})}
            >
              🍃{" "}
              {configs.some((c) => c.eco_suspend_until) ? "Eco suspended — manage" : "Suspend Eco"}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            + Register thermostat
          </button>
        </div>
      </div>

      <AirflowConfigBanner />

      <OutsideTempPicker />

      <SensorStalenessCard />

      {configs.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <p>No thermostats registered yet.</p>
            <p style={{ marginTop: ".5rem" }}>
              Click <strong>+ Register thermostat</strong> to add your first thermostat. Once
              registered, it will appear in the Room configuration picker by its friendly name.
            </p>
          </div>
        </div>
      ) : (
        configs.map((c) => (
          <ThermostatCard
            key={c.thermostat_entity_id}
            config={c}
            zoneHasRoomOptIn={rooms.some(
              (r) =>
                r.thermostat_entity_id === c.thermostat_entity_id && r.eco_mode_enabled === true
            )}
            onDeleted={load}
            onSuspendEco={() => setEcoSuspendFor({ thermostat: c.thermostat_entity_id })}
            onSaved={(updated) =>
              setConfigs((cs) =>
                cs.map((x) =>
                  x.thermostat_entity_id === updated.thermostat_entity_id ? updated : x
                )
              )
            }
          />
        ))
      )}

      {showAdd && (
        <AddThermostatModal
          onClose={() => setShowAdd(false)}
          onSave={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      {ecoSuspendFor && (
        <EcoSuspendModal
          thermostats={configs}
          initialThermostat={ecoSuspendFor.thermostat}
          onClose={() => setEcoSuspendFor(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
