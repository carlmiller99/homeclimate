import { useState } from "react";
import { clearPresenceHoldover, type ZoneStatus } from "../api";
import { useUnit } from "../contexts";
import { type House } from "../houseApi";
import { TargetsRow, type TargetLevel } from "./TargetsCard";

/** One temperature sensor of a room, as the Dashboard last read it. */
export interface SensorReading {
  entity_id: string;
  /** °F, or null when Home Assistant has no number for it. */
  value: number | null;
  /** Not reporting: left out of the room's average. */
  stale: boolean;
}

/**
 * Dashboard → a room: everything about one room in one place. Its
 * temperature, the targets it is kept between (its own, or the ones it
 * follows), a hold, what it follows, and each sensor's reading.
 */
export default function RoomDetailsModal({
  level,
  house,
  temp,
  readings,
  held,
  status,
  active,
  onClearedPresence,
  onSaved,
  onHold,
  onCancelHold,
  onOptions,
  onClose,
}: {
  /** The room as a targets level, with its zone (and building) above it. */
  level: TargetLevel;
  /** Null when the home's layout could not be read: no targets to show. */
  house: House | null;
  temp: number | null;
  readings: SensorReading[];
  held: boolean;
  /** What the room is doing or following right now, in a sentence. */
  status: string;
  /** The room as its zone's cycle reports it, when it is part of one. */
  active?: ZoneStatus["rooms"][number];
  /** Occupancy was cleared: read the Dashboard again. */
  onClearedPresence: () => void;
  onSaved: (house: House) => void;
  onHold: () => void;
  onCancelHold: () => void;
  onOptions: () => void;
  onClose: () => void;
}) {
  const { fmtTemp } = useUnit();
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const vents = Object.entries(active?.vent_states ?? {});
  const clearPresence = async () => {
    setClearing(true);
    setError("");
    try {
      await clearPresenceHoldover(level.id);
      onClearedPresence();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clear presence");
    } finally {
      setClearing(false);
    }
  };
  const asking =
    active?.target_temp == null
      ? null
      : active.eco_active &&
          active.requested_target != null &&
          active.target_temp !== active.requested_target
        ? `Asking for ${fmtTemp(active.target_temp)}. Eco Mode relaxed it from ${fmtTemp(active.requested_target)}.`
        : active.eco_active && active.requested_target != null
          ? `Asking for ${fmtTemp(active.target_temp)}, with Eco Mode on.`
          : `Asking for ${fmtTemp(active.target_temp)}.`;
  const where = [level.parent?.name, level.parent?.parent?.name].filter(Boolean).join(", ");
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${level.name} details`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal room-details">
        <div className="room-details-head">
          <div>
            <div className="modal-title">{level.name}</div>
            {where && <p className="field-help">{where}</p>}
          </div>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="room-details-now">
          <span className="room-details-temp">{temp != null ? fmtTemp(temp) : "No reading"}</span>
          <span className="field-help">
            {status}
            {asking && ` ${asking}`}
          </span>
        </div>

        {house && (
          <section className="room-details-block" aria-label="Targets">
            <h4 className="room-details-title">Targets</h4>
            <TargetsRow house={house} level={level} onSaved={onSaved} />
            <p className="field-help">
              Leave these empty and the room follows its zone or building. A hold, a schedule or
              occupancy comes first.
            </p>
          </section>
        )}

        <section className="room-details-block" aria-label="Hold">
          <h4 className="room-details-title">Hold</h4>
          <p className="field-help">
            {held
              ? "This room is on hold: kept at one temperature, ahead of everything else, until the hold ends."
              : "A hold keeps this room at one temperature for 1 to 8 hours, ahead of everything else, then lets go."}
          </p>
          <div className="room-details-actions">
            {held ? (
              <button type="button" className="btn btn-outline-danger" onClick={onCancelHold}>
                Cancel Hold
              </button>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={onHold}>
                Start a Hold
              </button>
            )}
          </div>
        </section>

        {house && (
          <section className="room-details-block" aria-label="What this room follows">
            <h4 className="room-details-title">What This Room Follows</h4>
            <p className="field-help">
              Whether the room is in use, and whether it follows its schedules and occupancy or only
              its targets.
            </p>
            <div className="room-details-actions">
              <button type="button" className="btn btn-secondary" onClick={onOptions}>
                In Use, Schedules and Occupancy
              </button>
            </div>
          </section>
        )}

        {active?.presence_active && (
          <section className="room-details-block" aria-label="Occupancy">
            <h4 className="room-details-title">Occupancy</h4>
            <p className="field-help">
              Someone was seen here, so the room is kept at its occupied temperature until its
              occupancy runs out. Clear it to end that now.
            </p>
            <div className="room-details-actions">
              <button
                type="button"
                className="btn btn-outline-danger"
                onClick={clearPresence}
                disabled={clearing}
              >
                {clearing ? "Clearing…" : "Clear Presence"}
              </button>
            </div>
            {error && <p className="form-error">{error}</p>}
          </section>
        )}

        {vents.length > 0 && (
          <section className="room-details-block" aria-label="Vents">
            <h4 className="room-details-title">Vents</h4>
            <p className="field-help">
              {`${vents.filter(([, state]) => state === "open").length} of ${vents.length} open`}
            </p>
            <ul className="room-details-sensors">
              {vents.map(([eid, state]) => (
                <li key={eid}>
                  <code>{eid}</code>
                  <span>
                    <span className={`vent-dot ${state}`} /> {state === "open" ? "Open" : "Closed"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="room-details-block" aria-label="Sensors">
          <h4 className="room-details-title">Sensors</h4>
          {readings.length === 0 ? (
            <p className="field-help">
              No temperature sensors. This room goes by its thermostat&apos;s reading. Add sensors
              in My Home.
            </p>
          ) : (
            <ul className="room-details-sensors">
              {readings.map((r) => (
                <li key={r.entity_id}>
                  <code>{r.entity_id}</code>
                  <span>
                    {r.stale
                      ? "Not reporting, left out of the average"
                      : r.value != null
                        ? fmtTemp(r.value)
                        : "No reading"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
