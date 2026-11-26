import { useEffect, useState } from "react";
import { useUnit } from "../contexts";
import {
  SWITCHING_LABELS,
  THRESHOLD_MAX_F,
  THRESHOLD_MIN_F,
  describeBuilding,
  getBuildingModes,
  setBuildingMode,
  type AutoLevel,
  type BuildingMode,
  type Switching,
} from "../buildingModeApi";

const LEVEL_LABELS: Record<AutoLevel, string> = {
  off: "Lets Each Zone Decide",
  watch: "Lets Each Zone Decide, and Logs What It Would Do",
  on: "Heats or Cools as One",
};

const LEVEL_HELP: Record<AutoLevel, string> = {
  off: "Each zone heats or cools whenever its own rooms need it. Two zones can be heating and cooling at the same time.",
  watch:
    "Zones still decide for themselves, but the log shows what the building would have done as one. A way to try it first.",
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
 * during render, keyed on the stored content (pitfall 9).
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
  return (
    <label className="field-stack">
      {`A Room Must Be This Far Past Its Target First (${unitLabel})`}
      <span className="threshold-row">
        <input
          className="form-control house-band-input"
          type="number"
          inputMode="decimal"
          step="any"
          min={low}
          max={high}
          aria-label={`Switching threshold for ${building.name} (${unitLabel})`}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          aria-label={`Save switching threshold for ${building.name}`}
          disabled={busy || !valid || text === stored}
          onClick={() => onSave({ switch_threshold: value })}
        >
          Save
        </button>
      </span>
      <span className="form-hint">
        {valid || text === stored
          ? "With a building that is heating and a cooling target of 72, a room has to reach 72 plus this much before the building thinks about switching to cooling."
          : `Between ${low} and ${high}${unitLabel}.`}
      </span>
    </label>
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
    <div className="card">
      <h3 className="card-title">Auto Mode</h3>
      <p className="page-subtitle">
        What a building does when its mode on the Dashboard is Auto. A building set to Heat Only,
        Cool Only or Off does not use this page.
      </p>
      {loadFailed && <p className="form-error">Could not load the buildings.</p>}
      {!loadFailed && !buildings && <p className="page-subtitle">Loading the buildings…</p>}
      {buildings && buildings.length === 0 && (
        <p className="page-subtitle">Add a building in My Home and put zones in it to use this.</p>
      )}
      {buildings?.map((b) => (
        <div key={b.building_id} className="calendar-row" role="group" aria-label={b.name}>
          <div className="calendar-room">
            <span className="sensor-title">{b.name}</span>
            <span className="shade-why">{describeBuilding(b)}</span>
          </div>
          <div className="auto-fields">
            <label className="field-stack">
              In Auto, This Building
              <select
                className="form-control"
                aria-label={`In Auto, ${b.name}`}
                value={b.auto_level}
                disabled={busy}
                onChange={(e) =>
                  void change(b.building_id, { auto_level: e.target.value as AutoLevel })
                }
              >
                {(Object.keys(LEVEL_LABELS) as AutoLevel[]).map((l) => (
                  <option key={l} value={l} title={LEVEL_HELP[l]}>
                    {LEVEL_LABELS[l]}
                  </option>
                ))}
              </select>
              <span className="form-hint">{LEVEL_HELP[b.auto_level]}</span>
              {b.mode !== "auto" && (
                <span className="form-hint">
                  This building is not set to Auto on the Dashboard, so none of this is in use.
                </span>
              )}
            </label>
            <label className="field-stack">
              It May Switch Between Heating and Cooling
              <select
                className="form-control"
                aria-label={`How often ${b.name} may switch`}
                value={b.switching}
                disabled={busy || b.auto_level === "off"}
                onChange={(e) =>
                  void change(b.building_id, { switching: e.target.value as Switching })
                }
              >
                {(Object.keys(SWITCHING_LABELS) as Switching[]).map((s) => (
                  <option key={s} value={s} title={SWITCHING_HELP[s]}>
                    {SWITCHING_LABELS[s]}
                  </option>
                ))}
              </select>
              <span className="form-hint">
                {b.auto_level === "off"
                  ? "Only used when the building heats or cools as one."
                  : SWITCHING_HELP[b.switching]}
              </span>
            </label>
            <ThresholdField
              building={b}
              busy={busy}
              onSave={(patch) => void change(b.building_id, patch)}
            />
          </div>
        </div>
      ))}
      {buildings && buildings.length > 0 && (
        <details className="targets-more">
          <summary>How often it may switch: what each choice means</summary>
          <dl className="choice-list">
            {(Object.keys(SWITCHING_LABELS) as Switching[]).map((s) => (
              <div key={s}>
                <dt>{SWITCHING_LABELS[s]}</dt>
                <dd>{SWITCHING_HELP[s]}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}
