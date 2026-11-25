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
  // The form holds display units and submits them as typed; the backend converts.
  const derived: EcoForm = {
    eco_mode_enabled: config.eco_mode_enabled ?? false,
    eco_cooling_outdoor_threshold: toDisplay(config.eco_cooling_outdoor_threshold),
    eco_cooling_full_drift_temp: toDisplay(config.eco_cooling_full_drift_temp),
    eco_cooling_max_drift: toDisplayDelta(config.eco_cooling_max_drift),
    eco_heating_outdoor_threshold: toDisplay(config.eco_heating_outdoor_threshold),
    eco_heating_full_drift_temp: toDisplay(config.eco_heating_full_drift_temp),
    eco_heating_max_drift: toDisplayDelta(config.eco_heating_max_drift),
    eco_hysteresis_band: toDisplayDelta(config.eco_hysteresis_band),
  };
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
  const dirty = !sameForm(form, lastDerived);

  const save = async () => {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      onSaved(await updateThermostat(tid, form));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const blocked = form.eco_mode_enabled && !hasOutsideSensor;
  return (
    <div className="card" role="group" aria-label={config.name}>
      <div className="eco-zone-head">
        <h3 className="card-title">{config.name}</h3>
        <label className="eco-zone-switch" htmlFor={`eco-${tid}-enabled`}>
          <span>Eco Mode</span>
          <Switch
            id={`eco-${tid}-enabled`}
            checked={form.eco_mode_enabled}
            label={`Eco Mode for ${config.name}`}
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
          Eco Mode needs an outside temperature sensor. Choose one in Settings, Sensors, then turn
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
        When it is very hot or very cold outside, Eco Mode lets each room&rsquo;s target drift a few
        degrees so the equipment works less. It is set for each zone here. A single room can be
        given its own Eco settings in My Home, and Eco can be suspended for a while from the
        Dashboard.
      </p>
      {loadFailed && <p className="form-error">Could not load the zones.</p>}
      {!loadFailed && !zones && <p className="page-subtitle">Loading the zones…</p>}
      {zones && !hasOutsideSensor && (
        <p className="fireplace-note">
          Eco Mode follows the outside temperature, and no outside temperature sensor is chosen yet.
          Choose one in Settings, Sensors. A weather integration&rsquo;s temperature sensor works.
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
