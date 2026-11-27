import { useEffect, useState } from "react";
import { useUnit } from "../contexts";
import {
  SWITCHING_LABELS,
  THRESHOLD_MAX_F,
  THRESHOLD_MIN_F,
  getBuildingModes,
  setBuildingMode,
  type AutoLevel,
  type BuildingMode,
  type Switching,
} from "../buildingModeApi";
import Segmented from "../components/Segmented";

const LEVEL_LABELS: Record<AutoLevel, string> = {
  off: "Each Zone Decides",
  watch: "Try It First",
  on: "Heats or Cools as One",
};

const LEVEL_HELP: Record<AutoLevel, string> = {
  off: "Each zone heats or cools whenever its own rooms need it. Two zones can be heating and cooling at the same time.",
  watch:
    "Zones still decide for themselves, but the log shows what the building would have done as one.",
  on: "The whole building is either heating or cooling. A zone that wants the other one waits until the building switches.",
};

const SWITCHING_HELP: Record<Switching, string> = {
  often:
    "At least 4 hours apart, and no more than twice a day. For days that need heat in the morning and cooling in the afternoon.",
  daily: "Once in any 24 hours. The building heats or cools for the day, and the other one waits.",
  weekly:
    "Once in any 7 days. It also waits until the forecast for the coming days calls for the switch, so one odd day does not use it up.",
  monthly:
    "Once in any 30 days: a change of season. It also waits until the forecast for the coming days calls for the switch.",
};

type Patch = Parameters<typeof setBuildingMode>[1];

/**
 * How far past its target a room must be before Auto considers changing sides.
 * Holds display-unit text; the backend converts on write (#231). Re-derived
 * during render, keyed on the stored content (pitfall 9). Saves on blur or
 * Enter; anything outside the limits goes back to what is stored.
 */
function ThresholdField({
  building,
  busy,
  onSave,
}: {
  building: BuildingMode;
  busy: boolean;
  onSave: (patch: Patch) => void;
}) {
  const { toDisplayDelta, displayBound, unitLabel } = useUnit();
  const stored = String(toDisplayDelta(building.switch_threshold));
  const [text, setText] = useState(stored);
  const [derived, setDerived] = useState(stored);
  if (derived !== stored) {
    setDerived(stored);
    setText(stored);
  }
  // Bounds the backend will accept once converted back (5.55 °C, not 5.56).
  const low = displayBound(THRESHOLD_MIN_F, "min", "delta");
  const high = displayBound(THRESHOLD_MAX_F, "max", "delta");
  const value = text.trim() === "" ? NaN : Number(text);
  const valid = Number.isFinite(value) && value >= low && value <= high;
  const commit = () => {
    if (!valid) setText(stored);
    else if (text !== stored) onSave({ switch_threshold: value });
  };
  return (
    <div className="field-stack">
      <span className="field-label">Once a Room Is Past Its Target By</span>
      <span className="threshold-row">
        <input
          className="form-control house-band-input"
          type="number"
          inputMode="decimal"
          step="any"
          min={low}
          max={high}
          aria-label={`Switching threshold for ${building.name} (${unitLabel})`}
          title={`Between ${low} and ${high}${unitLabel}.`}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <span className="minutes-unit">{unitLabel}</span>
      </span>
    </div>
  );
}

/** Smart Control → Auto Mode: what Auto means for each building. */
export default function BuildingAutoCard() {
  const [buildings, setBuildings] = useState<BuildingMode[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBuildingModes()
      .then((b) => {
        if (!cancelled) setBuildings(b);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (id: string, patch: Patch) => {
    setErr(null);
    setBusy(true);
    try {
      setBuildings(await setBuildingMode(id, patch));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section-stack">
      <div>
        <h3 className="card-title">Auto Mode</h3>
        <p className="page-subtitle">
          What a building does when its mode on the Dashboard is Auto.
        </p>
      </div>
      {loadFailed && <p className="form-error">Could not load the buildings.</p>}
      {!loadFailed && !buildings && <p className="page-subtitle">Loading the buildings…</p>}
      {buildings && buildings.length === 0 && (
        <p className="page-subtitle">Add a building in My Home and put zones in it to use this.</p>
      )}
      {buildings?.map((b) => (
        <section key={b.building_id} className="card auto-card" aria-label={b.name}>
          <div className="auto-head">
            <h4 className="sensor-title">{b.name}</h4>
            <Segmented
              label={`In Auto, ${b.name}`}
              value={b.auto_level}
              disabled={busy}
              options={(Object.keys(LEVEL_LABELS) as AutoLevel[]).map((l) => ({
                value: l,
                label: LEVEL_LABELS[l],
              }))}
              onChange={(l) => void change(b.building_id, { auto_level: l })}
            />
          </div>
          <p className="rule-help">
            {b.mode === "auto"
              ? LEVEL_HELP[b.auto_level]
              : "Not set to Auto on the Dashboard, so none of this is in use."}
          </p>
          {b.auto_level !== "off" && (
            <div className="auto-fields">
              <div className="field-stack">
                <span className="field-label">It May Switch Between Heating and Cooling</span>
                <Segmented
                  label={`How often ${b.name} may switch`}
                  value={b.switching}
                  disabled={busy}
                  options={(Object.keys(SWITCHING_LABELS) as Switching[]).map((s) => ({
                    value: s,
                    label: SWITCHING_LABELS[s],
                    title: SWITCHING_HELP[s],
                  }))}
                  onChange={(s) => void change(b.building_id, { switching: s })}
                />
                <span className="rule-help">{SWITCHING_HELP[b.switching]}</span>
              </div>
              <ThresholdField
                building={b}
                busy={busy}
                onSave={(patch) => void change(b.building_id, patch)}
              />
            </div>
          )}
        </section>
      ))}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}
