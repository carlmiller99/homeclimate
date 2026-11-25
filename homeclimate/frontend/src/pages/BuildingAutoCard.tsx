import { useEffect, useState } from "react";
import { useUnit } from "../contexts";
import {
  AUTO_LEVEL_LABELS,
  describeBuilding,
  getBuildingModes,
  setBuildingMode,
  type AutoLevel,
  type BuildingMode,
} from "../buildingModeApi";

const LEVEL_HELP: Record<AutoLevel, string> = {
  off: "Each zone chooses heating or cooling for itself, as it always has.",
  watch:
    "Works out the side for the whole building and logs what it would hold, but holds nothing.",
  on: "Keeps every zone in the building on one side, and switches when the forecast and the rooms call for it.",
};

/** Smart Control → Forecasts: how far each building's Auto mode is allowed to go. */
export default function BuildingAutoCard() {
  const { isCelsius } = useUnit();
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

  const change = async (id: string, auto_level: AutoLevel) => {
    setErr(null);
    setBusy(true);
    try {
      setBuildings(await setBuildingMode(id, { auto_level }));
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
        one zone is never cooling what another just heated. It switches sides only after the running
        cycle ends, a zone has waited 10 minutes, 4 hours have passed since the last switch, and the
        forecast does not rule it out, and no more than twice a day. A room{" "}
        {isCelsius ? "1.1°" : "2°"} past where it would start switches it sooner. Safety limits are
        never held back.
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
          <label className="field-stack">
            Auto
            <select
              className="form-control"
              aria-label={`Auto for ${b.name}`}
              value={b.auto_level}
              disabled={busy}
              onChange={(e) => void change(b.building_id, e.target.value as AutoLevel)}
            >
              {(Object.keys(AUTO_LEVEL_LABELS) as AutoLevel[]).map((l) => (
                <option key={l} value={l}>
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
        </div>
      ))}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}
