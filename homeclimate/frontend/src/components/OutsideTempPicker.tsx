import { useEffect, useState } from "react";
import {
  getOutsideTempEntity,
  setOutsideTempEntities,
  type OutsideTempEntitySetting,
} from "../api";
import { useUnit } from "../contexts";
import { useEntityName } from "../entityNames";
import EntityPicker from "./EntityPicker";
import { CrossIcon } from "./icons";

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
  const [adding, setAdding] = useState(false);

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

  // Adding builds on the list last read from the server, so it waits for a
  // load to have succeeded and for any save in flight: otherwise a pick made
  // after a failed load, or on the heels of another, would replace the list.
  const ready = current !== null && !saving;
  const add = (entityId: string | null) => {
    if (!ready || !entityId || sensors.includes(entityId)) return;
    void save([...sensors, entityId]);
  };

  /** One sensor's own reading; with a single sensor that is the house's. */
  const readingOf = (entityId: string): number | null => {
    const own = current?.values?.[entityId];
    if (own !== undefined) return own;
    return sensors.length === 1 && current ? current.current_value : null;
  };

  const average = current?.current_value;
  return (
    <section className="card outside-card" aria-label="Outside">
      <div className="outside-now">
        <span className="field-label">Outside</span>
        <span className="outside-temp">
          {average === null || average === undefined ? "—" : fmtTemp(average)}
        </span>
        <span className="rule-help">
          {sensors.length === 0
            ? "No sensor yet. Eco Mode needs one."
            : sensors.length === 1
              ? "From 1 sensor"
              : `Average of ${sensors.length} sensors`}
        </span>
      </div>
      <div className="outside-sensors">
        {sensors.map((entityId) => (
          <OutsideSensor
            key={entityId}
            entityId={entityId}
            reading={readingOf(entityId)}
            disabled={saving}
            onRemove={() => void save(sensors.filter((s) => s !== entityId))}
          />
        ))}
        {adding ? (
          <div className="outside-add">
            <EntityPicker
              domain={["sensor", "weather"]}
              placeholder="Search sensors and weather…"
              onSelect={(id) => {
                add(id);
                setAdding(false);
              }}
            />
          </div>
        ) : (
          <button
            className="btn btn-secondary"
            type="button"
            disabled={!ready}
            onClick={() => setAdding(true)}
          >
            Add Sensor
          </button>
        )}
        {error && <span className="badge badge-red">{error}</span>}
        {current === null && error && (
          <button className="btn btn-secondary" onClick={() => void refresh()} type="button">
            Try Again
          </button>
        )}
      </div>
    </section>
  );
}

/** One outside sensor: its friendly name, its own reading, and a way to remove it. */
function OutsideSensor({
  entityId,
  reading,
  disabled,
  onRemove,
}: {
  entityId: string;
  reading: number | null;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { fmtTemp } = useUnit();
  const name = useEntityName(entityId);
  return (
    <span className="outside-chip" title={entityId}>
      {name}
      <strong>{reading === null ? "No reading" : fmtTemp(reading)}</strong>
      <button
        className="icon-button"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
        disabled={disabled}
        type="button"
      >
        <CrossIcon />
      </button>
    </span>
  );
}
