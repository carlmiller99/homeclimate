import { entityName } from "../entityNames";
import { useState } from "react";
import {
  describeBuilding,
  MODE_LABELS,
  setBuildingMode,
  type BuildingMode,
  type BuildingModeName,
} from "../buildingModeApi";

/** Dashboard: a building's heating/cooling mode, and what it is doing about it. */
export default function BuildingModeControl({
  building,
  zoneNames,
  onSaved,
}: {
  building: BuildingMode;
  /** Thermostat entity id → the zone's name, for "Upstairs is waiting to cool". */
  zoneNames: Record<string, string>;
  onSaved: (buildings: BuildingMode[]) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (mode: BuildingModeName) => {
    setError(null);
    setSaving(true);
    try {
      onSaved(await setBuildingMode(building.building_id, { mode }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the mode");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="building-mode">
      <label className="building-mode-pick">
        <span className="field-label">
          Mode<span className="sr-only">{` for ${building.name}`}</span>
        </span>
        <select
          className="form-control"
          value={building.mode}
          disabled={saving}
          onChange={(e) => void change(e.target.value as BuildingModeName)}
        >
          {(Object.keys(MODE_LABELS) as BuildingModeName[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <span className="building-mode-status" role="status">
        {describeBuilding(building)}
        {building.waiting.map((w) => (
          <span key={w.thermostat_entity_id} className="building-mode-wait">
            {` ${zoneNames[w.thermostat_entity_id] ?? entityName(w.thermostat_entity_id)} ${
              w.obeyed ? "is waiting" : "would be waiting"
            } to start ${w.direction}.`}
          </span>
        ))}
      </span>
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}
