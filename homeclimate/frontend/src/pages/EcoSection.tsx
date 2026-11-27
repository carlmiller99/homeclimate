import { entityName } from "../entityNames";
import { useEffect, useState } from "react";
import {
  getOutsideTempEntity,
  getThermostats,
  updateThermostat,
  type ThermostatConfig,
} from "../api";
import { EcoChart, EcoSlider } from "../components/EcoDrift";
import { RuleRow } from "../components/SmartControlControls";
import { Switch } from "../components/SmartControlControls";
import { useUnit } from "../contexts";
import { ECO_NUMERIC_FIELDS, type EcoNumericKey } from "../eco";

type EcoForm = { eco_mode_enabled: boolean; eco_empty_zone_hours: number } & Record<
  EcoNumericKey,
  number
>;

/** How much further an empty zone may drift, in °F (`eco.EMPTY_ZONE_EXTRA_F`). */
const EMPTY_ZONE_EXTRA_F = 2;
const EMPTY_ZONE_MIN_HOURS = 0.5;
const EMPTY_ZONE_MAX_HOURS = 72;
const EMPTY_ZONE_DEFAULT_HOURS = 2;

/** The settings most people never touch, in plain words. */
const ADVANCED_LABELS: Partial<Record<EcoNumericKey, string>> = {
  eco_heating_full_drift_temp: "Cold days: full drift once outside is down to",
  eco_cooling_full_drift_temp: "Hot days: full drift once outside is up to",
  eco_hysteresis_band: "Keep drifting until outside comes back by",
};

const sameForm = (a: EcoForm, b: EcoForm) =>
  (Object.keys(a) as (keyof EcoForm)[]).every((k) => Object.is(a[k], b[k]));

function EcoZoneCard({
  config,
  hasOutsideSensor,
  onSaved,
}: {
  config: ThermostatConfig;
  hasOutsideSensor: boolean;
  onSaved: (updated: ThermostatConfig) => void;
}) {
  const { unitLabel, isCelsius, toDisplay, toDisplayDelta } = useUnit();
  const tid = config.thermostat_entity_id;
  const title = config.name || entityName(tid);
  // The form holds display units and submits them as typed; the backend converts.
  const derive = (cfg: ThermostatConfig): EcoForm => ({
    eco_mode_enabled: cfg.eco_mode_enabled ?? false,
    eco_empty_zone_hours: cfg.eco_empty_zone_hours ?? 0,
    eco_cooling_outdoor_threshold: toDisplay(cfg.eco_cooling_outdoor_threshold),
    eco_cooling_full_drift_temp: toDisplay(cfg.eco_cooling_full_drift_temp),
    eco_cooling_max_drift: toDisplayDelta(cfg.eco_cooling_max_drift),
    eco_heating_outdoor_threshold: toDisplay(cfg.eco_heating_outdoor_threshold),
    eco_heating_full_drift_temp: toDisplay(cfg.eco_heating_full_drift_temp),
    eco_heating_max_drift: toDisplayDelta(cfg.eco_heating_max_drift),
    eco_hysteresis_band: toDisplayDelta(cfg.eco_hysteresis_band),
  });
  const derived = derive(config);
  const [form, setForm] = useState(derived);
  const [lastDerived, setLastDerived] = useState(derived);
  const [emptyOn, setEmptyOn] = useState(derived.eco_empty_zone_hours !== 0);
  if (!sameForm(lastDerived, derived)) {
    // What is stored changed (a save, or the display unit): show it. A refetch
    // that returns the same values leaves an edit in progress alone.
    setLastDerived(derived);
    setForm(derived);
    setEmptyOn(derived.eco_empty_zone_hours !== 0);
  }
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = (Object.keys(form) as (keyof EcoForm)[]).filter(
    (k) => !Object.is(form[k], lastDerived[k])
  );
  const dirty = changed.length > 0;

  const save = async () => {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      // Only what was changed is sent. A value left alone is not rewritten
      // from its rounded display form, so it cannot drift or be refused.
      const updated = await updateThermostat(
        tid,
        Object.fromEntries(changed.map((k) => [k, form[k]]))
      );
      // Show what was stored, even where it rounds to what was already shown.
      const stored = derive(updated);
      setLastDerived(stored);
      setForm(stored);
      setEmptyOn(stored.eco_empty_zone_hours !== 0);
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  // Off is stored as 0 hours. The switch is its own cell so that typing a
  // number that starts with 0 ("0.5") does not switch the row off mid-entry.
  const hoursOk =
    !emptyOn ||
    (Number.isFinite(form.eco_empty_zone_hours) &&
      form.eco_empty_zone_hours >= EMPTY_ZONE_MIN_HOURS &&
      form.eco_empty_zone_hours <= EMPTY_ZONE_MAX_HOURS);
  // Only turning it on needs the sensor; a zone already on can still be tuned.
  const blocked = form.eco_mode_enabled && !lastDerived.eco_mode_enabled && !hasOutsideSensor;
  const set = (patch: Partial<EcoForm>) => {
    setSaved(false);
    setForm((f) => ({ ...f, ...patch }));
  };
  const numbersOk = ECO_NUMERIC_FIELDS.every(({ key }) => Number.isFinite(form[key]));
  // Slider ranges in the unit shown.
  const r = isCelsius
    ? { cold: [-18, 16], hot: [21, 43], drift: [0, 4.5], step: 0.5 }
    : { cold: [-20, 60], hot: [70, 110], drift: [0, 8], step: 1 };
  const advanced = ECO_NUMERIC_FIELDS.filter(({ key }) => key in ADVANCED_LABELS);
  return (
    <div className="card eco-card" role="group" aria-label={title}>
      <div className="eco-zone-head">
        <div>
          <h3 className="card-title">{title}</h3>
          {!form.eco_mode_enabled && (
            <p className="rule-help">Off. Rooms hold their targets in any weather.</p>
          )}
        </div>
        <Switch
          id={`eco-${tid}-enabled`}
          checked={form.eco_mode_enabled}
          label={`Eco Mode for ${title}`}
          disabled={saving}
          onChange={(v) => set({ eco_mode_enabled: v })}
        />
      </div>
      {form.eco_mode_enabled && (
        <>
          {numbersOk && (
            <div className="eco-chart-box">
              <EcoChart
                params={{
                  coolingThreshold: form.eco_cooling_outdoor_threshold,
                  coolingFullDrift: form.eco_cooling_full_drift_temp,
                  coolingMaxDrift: form.eco_cooling_max_drift,
                  heatingThreshold: form.eco_heating_outdoor_threshold,
                  heatingFullDrift: form.eco_heating_full_drift_temp,
                  heatingMaxDrift: form.eco_heating_max_drift,
                }}
              />
            </div>
          )}
          <div className="eco-sides">
            <div className="eco-side">
              <strong className="eco-side-title eco-side-heat">On Cold Days</strong>
              <EcoSlider
                id={`eco-${tid}-heat-at`}
                label="Start When Outside Is Below"
                value={form.eco_heating_outdoor_threshold}
                min={r.cold[0]}
                max={r.cold[1]}
                step={r.step}
                disabled={saving}
                onChange={(v) =>
                  set({
                    eco_heating_outdoor_threshold: v,
                    // The full drift is never reached before the drift starts.
                    eco_heating_full_drift_temp: Math.min(form.eco_heating_full_drift_temp, v),
                  })
                }
              />
              <EcoSlider
                id={`eco-${tid}-heat-by`}
                label="Let Rooms Run Cooler By Up To"
                value={form.eco_heating_max_drift}
                min={r.drift[0]}
                max={r.drift[1]}
                step={0.5}
                disabled={saving}
                onChange={(v) => set({ eco_heating_max_drift: v })}
              />
            </div>
            <div className="eco-side">
              <strong className="eco-side-title eco-side-cool">On Hot Days</strong>
              <EcoSlider
                id={`eco-${tid}-cool-at`}
                label="Start When Outside Is Above"
                value={form.eco_cooling_outdoor_threshold}
                min={r.hot[0]}
                max={r.hot[1]}
                step={r.step}
                disabled={saving}
                onChange={(v) =>
                  set({
                    eco_cooling_outdoor_threshold: v,
                    eco_cooling_full_drift_temp: Math.max(form.eco_cooling_full_drift_temp, v),
                  })
                }
              />
              <EcoSlider
                id={`eco-${tid}-cool-by`}
                label="Let Rooms Run Warmer By Up To"
                value={form.eco_cooling_max_drift}
                min={r.drift[0]}
                max={r.drift[1]}
                step={0.5}
                disabled={saving}
                onChange={(v) => set({ eco_cooling_max_drift: v })}
              />
            </div>
          </div>
          <RuleRow
            id={`eco-${tid}-empty`}
            title="Let an Empty Zone Drift Further"
            help={`After nobody has used the zone this long, rooms may drift ${toDisplayDelta(EMPTY_ZONE_EXTRA_F)}${unitLabel} more.`}
            enabled={emptyOn}
            disabled={saving}
            onToggle={(v) => {
              setEmptyOn(v);
              set({ eco_empty_zone_hours: v ? EMPTY_ZONE_DEFAULT_HOURS : 0 });
            }}
          >
            <span className="minutes-field">
              <input
                className="form-control minutes-input"
                type="number"
                min={EMPTY_ZONE_MIN_HOURS}
                max={EMPTY_ZONE_MAX_HOURS}
                step={0.5}
                aria-label={`Hours before ${title} drifts further`}
                disabled={saving || !emptyOn}
                value={
                  emptyOn && Number.isFinite(form.eco_empty_zone_hours)
                    ? form.eco_empty_zone_hours
                    : ""
                }
                onChange={(e) => set({ eco_empty_zone_hours: parseFloat(e.target.value) })}
              />
              <span className="minutes-unit">hr</span>
            </span>
          </RuleRow>
          <details className="advanced-box">
            <summary>
              <strong>Advanced Options</strong>
              <span>You don&rsquo;t need to change these unless you want to.</span>
            </summary>
            <div className="advanced-rows">
              {advanced.map(({ key, step }) => (
                <label className="advanced-row" key={key} htmlFor={`eco-${tid}-${key}`}>
                  <span>{ADVANCED_LABELS[key]}</span>
                  <span className="minutes-field">
                    <input
                      id={`eco-${tid}-${key}`}
                      className="form-control minutes-input"
                      type="number"
                      step={step}
                      value={Number.isFinite(form[key]) ? form[key] : ""}
                      disabled={saving}
                      onChange={(e) => set({ [key]: parseFloat(e.target.value) })}
                    />
                    <span className="minutes-unit">{unitLabel}</span>
                  </span>
                </label>
              ))}
            </div>
          </details>
        </>
      )}
      {blocked && (
        <p className="form-error">
          Eco Mode needs an outside temperature sensor. Choose one in My Home, Outside, then turn
          this on.
        </p>
      )}
      {!numbersOk && <p className="form-error">Every field needs a number.</p>}
      {!hoursOk && (
        <p className="form-error">{`Hours must be between ${EMPTY_ZONE_MIN_HOURS} and ${EMPTY_ZONE_MAX_HOURS}.`}</p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="eco-zone-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !dirty || blocked || !hoursOk || !numbersOk}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && !dirty && (
          <span className="shade-why" role="status">
            Saved
          </span>
        )}
      </div>
    </div>
  );
}

/** Smart Control → Eco Mode: relax targets when it is extreme outside. */
export default function EcoSection() {
  const [zones, setZones] = useState<ThermostatConfig[] | null>(null);
  const [hasOutsideSensor, setHasOutsideSensor] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getThermostats(), getOutsideTempEntity().catch(() => null)])
      .then(([t, outside]) => {
        if (cancelled) return;
        setZones(t);
        setHasOutsideSensor(!!outside?.entity_id);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="sc-section" id="eco-mode">
      <h2 className="sc-section-title">Eco Mode</h2>
      <p className="sc-section-lead">
        On very hot or very cold days, rooms drift a few degrees from their target so the equipment
        runs less.
      </p>
      {loadFailed && <p className="form-error">Could not load the zones.</p>}
      {!loadFailed && !zones && <p className="page-subtitle">Loading the zones…</p>}
      {zones && !hasOutsideSensor && (
        <p className="fireplace-note">
          Eco Mode follows the outside temperature, and no outside temperature sensor is chosen yet.
          Choose one in My Home, Outside. A weather integration&rsquo;s temperature sensor works.
        </p>
      )}
      {zones && zones.length === 0 && (
        <p className="page-subtitle">Add a zone in My Home to use Eco Mode.</p>
      )}
      {zones?.map((z) => (
        <EcoZoneCard
          key={z.thermostat_entity_id}
          config={z}
          hasOutsideSensor={hasOutsideSensor}
          onSaved={(u) =>
            setZones(
              (all) =>
                all?.map((x) => (x.thermostat_entity_id === u.thermostat_entity_id ? u : x)) ?? null
            )
          }
        />
      ))}
    </section>
  );
}
