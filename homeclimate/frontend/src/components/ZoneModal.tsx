import { useState } from "react";
import { useUnit } from "../contexts";
import { ZONE_MODE_LABELS, zoneWaitText, type BuildingMode } from "../buildingModeApi";
import { type House } from "../houseApi";
import { updateZone, type ZoneMode, type ZoneProfile } from "../zonesApi";
import Segmented from "./Segmented";
import { effective, TargetsRow, type TargetLevel } from "./TargetsCard";

/**
 * Dashboard → a zone: its mode (follow its building, or its own) and the
 * baseline targets its rooms follow unless they have their own.
 */
export default function ZoneModal({
  zone,
  level,
  house,
  building,
  thermostatTemp,
  onSavedZone,
  onSaved,
  onClose,
}: {
  zone: ZoneProfile;
  /** The zone as a targets level, under its building when it is in one. */
  level: TargetLevel;
  house: House | null;
  /** The zone's building and what its zones are doing, or null when in none. */
  building: BuildingMode | null;
  thermostatTemp: number | null;
  onSavedZone: (saved: ZoneProfile) => void;
  onSaved: (house: House) => void;
  onClose: () => void;
}) {
  const { fmtTemp, toDisplay, unitLabel } = useUnit();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inBuilding = building !== null;
  // A zone in no building has nothing to follow: following is Auto.
  const mode: ZoneMode = !inBuilding && zone.mode === "follow" ? "auto" : zone.mode;
  const choices = (Object.keys(ZONE_MODE_LABELS) as ZoneMode[]).filter(
    (m) => inBuilding || m !== "follow"
  );
  const state = building?.zones.find((z) => z.thermostat_entity_id === zone.thermostat_entity_id);
  const wait = state && building ? zoneWaitText(state, building) : null;
  const above = house ? effective(house, level.parent) : null;
  const range = (heat: number, cool: number) =>
    cool === heat ? fmtTemp(heat) : `${toDisplay(heat)} to ${toDisplay(cool)}${unitLabel}`;
  const sub = [
    building?.name,
    thermostatTemp != null ? `Thermostat ${fmtTemp(thermostatTemp)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const setMode = async (next: ZoneMode) => {
    setSaving(true);
    setError("");
    try {
      onSavedZone(await updateZone(zone.thermostat_entity_id, { mode: next }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the mode");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${level.name} settings`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal room-details">
        <div className="room-details-head">
          <div>
            <div className="modal-title">{level.name}</div>
            {sub && <p className="field-help">{sub}</p>}
          </div>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>

        <section className="room-details-block" aria-label="Mode">
          <h4 className="room-details-title">Mode</h4>
          <p className="field-help">
            {inBuilding
              ? `Follow ${building.name}, or set this zone's own.`
              : "Auto switches between heating and cooling as rooms need it."}
          </p>
          <div className="room-details-control">
            <Segmented
              label={`Mode for ${level.name}`}
              value={mode}
              options={choices.map((m) => ({ value: m, label: ZONE_MODE_LABELS[m] }))}
              disabled={saving}
              onChange={(m) => void setMode(m)}
            />
          </div>
          {wait && <p className="room-details-say">{wait}</p>}
          {error && <p className="form-error">{error}</p>}
        </section>

        {house && (
          <section className="room-details-block" aria-label="Baseline temperature target">
            <h4 className="room-details-title">Baseline Temperature Target</h4>
            <p className="field-help">
              {`${
                above
                  ? `Leave empty to follow ${above.from.name}: ${range(above.heat, above.cool)}.`
                  : "Leave empty and rooms here are kept at nothing in particular."
              } Rooms with their own targets keep them.`}
            </p>
            <TargetsRow house={house} level={level} onSaved={onSaved} bare />
          </section>
        )}
      </div>
    </div>
  );
}
