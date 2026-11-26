import { useEffect, useState } from "react";
import {
  getOutsideTempEntity,
  getThermostats,
  updateThermostat,
  type ThermostatConfig,
} from "../api";
import { EcoWorkedExample } from "../components/EcoMode";
import { Switch } from "../components/SmartControlControls";
import { useUnit } from "../contexts";
import { ECO_NUMERIC_FIELDS, type EcoNumericKey } from "../eco";

type EcoForm = { eco_mode_enabled: boolean } & Record<EcoNumericKey, number>;

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
  const { unitLabel, toDisplay, toDisplayDelta } = useUnit();
  const tid = config.thermostat_entity_id;
  const title = config.name || tid;
  // The form holds display units and submits them as typed; the backend converts.
  const derive = (cfg: ThermostatConfig): EcoForm => ({
    eco_mode_enabled: cfg.eco_mode_enabled ?? false,
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
  if (!sameForm(lastDerived, derived)) {
    // What is stored changed (a save, or the display unit): show it. A refetch
    // that returns the same values leaves an edit in progress alone.
    setLastDerived(derived);
    setForm(derived);
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
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  // Only turning it on needs the sensor; a zone already on can still be tuned.
  const blocked = form.eco_mode_enabled && !lastDerived.eco_mode_enabled && !hasOutsideSensor;
  return (
    <div className="card" role="group" aria-label={title}>
      <div className="eco-zone-head">
        <h3 className="card-title">{title}</h3>
        <label className="eco-zone-switch" htmlFor={`eco-${tid}-enabled`}>
          <span>Eco Mode</span>
          <Switch
            id={`eco-${tid}-enabled`}
            checked={form.eco_mode_enabled}
            label={`Eco Mode for ${title}`}
            disabled={saving}
            onChange={(v) => {
              setSaved(false);
              setForm((f) => ({ ...f, eco_mode_enabled: v }));
            }}
          />
        </label>
      </div>
      <div className="eco-grid">
        {ECO_NUMERIC_FIELDS.map(({ key, label, help, step, kind }) => (
          <div className="form-group" key={key}>
            <label className="form-label" htmlFor={`eco-${tid}-${key}`}>
              {`${label} (${unitLabel})`}
            </label>
            <input
              id={`eco-${tid}-${key}`}
              className="form-control"
              type="number"
              step={step}
              value={Number.isFinite(form[key]) ? form[key] : ""}
              disabled={saving}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setSaved(false);
                setForm((f) => ({ ...f, [key]: v }));
              }}
            />
            <div className="form-hint">
              {kind === "absolute_temp" ? "Outdoor temperature. " : "Difference. "}
              {help}
            </div>
          </div>
        ))}
      </div>
      <EcoWorkedExample
        params={{
          coolingThreshold: form.eco_cooling_outdoor_threshold,
          coolingFullDrift: form.eco_cooling_full_drift_temp,
          coolingMaxDrift: form.eco_cooling_max_drift,
          heatingThreshold: form.eco_heating_outdoor_threshold,
          heatingFullDrift: form.eco_heating_full_drift_temp,
          heatingMaxDrift: form.eco_heating_max_drift,
        }}
      />
      {blocked && (
        <p className="form-error">
          Eco Mode needs an outside temperature sensor. Choose one in My Home, Outside, then turn
          this on.
        </p>
      )}
      {ECO_NUMERIC_FIELDS.some(({ key }) => !Number.isFinite(form[key])) && (
        <p className="form-error">Every field needs a number.</p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="eco-zone-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            saving ||
            !dirty ||
            blocked ||
            ECO_NUMERIC_FIELDS.some(({ key }) => !Number.isFinite(form[key]))
          }
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
        On very hot or very cold days, lets each room drift a few degrees from its target so the
        equipment runs less.
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
