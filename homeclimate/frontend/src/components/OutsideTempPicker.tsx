import { useEffect, useState } from "react";
import {
  getOutsideTempEntity,
  setOutsideTempEntities,
  type OutsideTempEntitySetting,
} from "../api";
import { useUnit } from "../contexts";
import EntityPicker from "./EntityPicker";

/** The sensors in a setting, whichever shape the backend sent. */
function sensorsOf(setting: OutsideTempEntitySetting | null): string[] {
  if (!setting) return [];
  return setting.entity_ids ?? (setting.entity_id ? [setting.entity_id] : []);
}

/**
 * House-wide outdoor-temperature picker: one sensor, or several averaged.
 *
 * It serves the whole home — it is NOT tied to an individual thermostat. The
 * reading is recorded at the start and end of every cycle for the analytics,
 * and drives the per-thermostat cooling lockout (Issue #209), Eco Mode,
 * pre-cool/pre-heat and the forecasts' accuracy check. With several sensors
 * the house's outside temperature is their average, and one that stops
 * answering is left out until it comes back.
 *
 * ``onChange`` fires with the first configured entity id (or null) on load and
 * on every save, so a parent can react (e.g. enable/disable dependent settings).
 */
export default function OutsideTempPicker({
  onChange,
}: {
  onChange?: (entityId: string | null) => void;
}) {
  const { fmtTemp } = useUnit();
  const [current, setCurrent] = useState<OutsideTempEntitySetting | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      const cur = await getOutsideTempEntity();
      setCurrent(cur);
      setError("");
      onChange?.(cur.entity_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sensors = sensorsOf(current);

  const save = async (next: string[]) => {
    setSaving(true);
    setError("");
    try {
      const saved = await setOutsideTempEntities(next);
      setCurrent(saved);
      onChange?.(saved.entity_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const add = (entityId: string | null) => {
    if (!entityId || sensors.includes(entityId)) return;
    void save([...sensors, entityId]);
  };

  /** One sensor's own reading; with a single sensor that is the house's. */
  const readingOf = (entityId: string): number | null => {
    const own = current?.values?.[entityId];
    if (own !== undefined) return own;
    return sensors.length === 1 ? (current?.current_value ?? null) : null;
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div className="card-title">Outside temperature sensors</div>
      <div className="text-sm text-muted" style={{ marginBottom: "1rem" }}>
        One Home Assistant sensor for the whole home, or several: with more than one, HomeClimate
        uses their average, and leaves out any that stops answering. It is not tied to a specific
        thermostat. The reading is recorded at the start and end of every cycle for the analytics,
        and it is <strong>required</strong> for the cooling lockout, Eco Mode and pre-cool/pre-heat.
      </div>

      {error && (
        <div className="badge badge-red" style={{ marginBottom: ".75rem" }}>
          {error}
        </div>
      )}

      <div style={{ maxWidth: 420, marginBottom: ".75rem" }}>
        <EntityPicker
          domain={["sensor", "weather"]}
          placeholder={
            sensors.length > 0
              ? "Add another sensor / weather entity…"
              : "Search sensor / weather entities…"
          }
          onSelect={add}
        />
      </div>

      {sensors.length === 0 ? (
        <span className="text-sm text-muted">— None configured —</span>
      ) : (
        <div style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap" }}>
          {sensors.map((entityId) => {
            const reading = readingOf(entityId);
            return (
              <span
                key={entityId}
                style={{ display: "inline-flex", gap: ".35rem", alignItems: "center" }}
              >
                <span className="badge badge-blue">
                  {`${entityId} · ${reading === null ? "no reading" : fmtTemp(reading)}`}
                </span>
                <button
                  className="btn btn-secondary btn-sm"
                  aria-label={`Remove ${entityId}`}
                  onClick={() => void save(sensors.filter((s) => s !== entityId))}
                  disabled={saving}
                  type="button"
                >
                  Remove
                </button>
              </span>
            );
          })}
        </div>
      )}

      {sensors.length > 1 && (
        <div className="form-hint" style={{ marginTop: ".6rem" }}>
          {current?.current_value === null || current?.current_value === undefined
            ? `Average of ${sensors.length} sensors: no reading right now`
            : `Average of ${sensors.length} sensors: ${fmtTemp(current.current_value)}`}
        </div>
      )}
    </div>
  );
}
