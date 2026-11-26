import { useEffect, useState } from "react";
import { useUnit } from "../contexts";
import {
  AUTO_LEVEL_LABELS,
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

const LEVEL_HELP: Record<AutoLevel, string> = {
  off: "Zones run independently: each chooses heating or cooling for itself.",
  watch:
    "Works out the side for the whole building and logs what it would hold, but holds nothing.",
  on: "Keeps every zone in the building on one side, and changes sides only as often as you allow below.",
};

const SWITCHING_HELP: Record<Switching, string> = {
  often:
    "Changes at least 4 hours apart, and no more than twice a day. For days that need heat in the morning and cooling in the afternoon.",
  daily:
    "One change in any 24 hours, counted from the last one. The building heats or cools for the day, and the other side waits.",
  weekly:
    "One change in any 7 days, counted from the last one. It also waits until the forecast for the coming days favours the other side, so one odd day does not use it up.",
  monthly:
    "One change in any 30 days, counted from the last one: a change of season. It also waits until the forecast for the coming days favours the other side.",
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
  const { toDisplayDelta, unitLabel } = useUnit();
  const stored = String(toDisplayDelta(building.switch_threshold));
  const [text, setText] = useState(stored);
  const [derived, setDerived] = useState(stored);
  if (derived !== stored) {
    setDerived(stored);
    setText(stored);
  }
  const low = toDisplayDelta(THRESHOLD_MIN_F);
  const high = toDisplayDelta(THRESHOLD_MAX_F);
  const value = text.trim() === "" ? NaN : Number(text);
  const valid = Number.isFinite(value) && value >= low && value <= high;
  return (
    <label className="field-stack">
      {`Switching Threshold (${unitLabel})`}
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
          ? "How far past its target on the other side a room must be before Auto considers changing sides."
          : `Between ${low} and ${high}${unitLabel}.`}
      </span>
    </label>
  );
}

/** Smart Control → Forecasts: what Auto means for each building. */
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
      <h3 className="card-title">One Side Per Building</h3>
      <p className="page-subtitle">
        Zones that share a building share its air. Auto keeps them all heating or all cooling, so
        one zone is never cooling what another just heated. It changes sides only when a room is the
        switching threshold past its target on the other side, the running cycle has ended, a zone
        has waited 10 minutes, the limit you choose here allows it, and the forecast does not rule
        it out. The limit always holds, however far out a room is: to change sides sooner, set the
        building to Heat Only or Cool Only on the Dashboard. Safety limits are never held back.
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
              Auto
              <select
                className="form-control"
                aria-label={`Auto for ${b.name}`}
                value={b.auto_level}
                disabled={busy}
                onChange={(e) =>
                  void change(b.building_id, { auto_level: e.target.value as AutoLevel })
                }
              >
                {(Object.keys(AUTO_LEVEL_LABELS) as AutoLevel[]).map((l) => (
                  <option key={l} value={l} title={LEVEL_HELP[l]}>
                    {AUTO_LEVEL_LABELS[l]}
                  </option>
                ))}
              </select>
              <span className="form-hint">{LEVEL_HELP[b.auto_level]}</span>
              {b.mode !== "auto" && (
                <span className="form-hint">
                  This building is set to a fixed mode on the Dashboard, so Auto is not in use.
                </span>
              )}
            </label>
            <label className="field-stack">
              Auto May Change Sides
              <select
                className="form-control"
                aria-label={`Auto may change sides for ${b.name}`}
                value={b.switching}
                disabled={busy}
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
              <span className="form-hint">{SWITCHING_HELP[b.switching]}</span>
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
          <summary>What each choice means</summary>
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
