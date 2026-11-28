import EntityName from "./EntityName";
import { useState } from "react";
import { clearPresenceHoldover, type Room, type ZoneStatus } from "../api";
import { useUnit } from "../contexts";
import { targetsFor, type House } from "../houseApi";
import OccupiedTargets from "./OccupiedTargets";
import { effective, TargetsRow, type TargetLevel } from "./TargetsCard";

/** One temperature sensor of a room, as the Dashboard last read it. */
export interface SensorReading {
  entity_id: string;
  /** °F, or null when Home Assistant has no number for it. */
  value: number | null;
  /** Not reporting: left out of the room's average. */
  stale: boolean;
}

/** A part of the room that opens on a tap: its name and what it is set to. */
function Collapsible({
  title,
  value,
  children,
}: {
  title: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <details className="room-details-block room-details-more">
      <summary>
        <span className="room-details-title">{title}</span>
        <span className="room-details-value">
          {value}
          <span className="room-details-chevron" aria-hidden="true" />
        </span>
      </summary>
      <div className="room-details-body">{children}</div>
    </details>
  );
}

/**
 * Dashboard → a room: its temperature now, the temperatures it is kept
 * between (its baseline, and while occupied or empty), a hold, and its vents.
 * Its sensors and what it follows are set in My Home and Smart Control.
 */
export default function RoomDetailsModal({
  level,
  house,
  temp,
  held,
  status,
  active,
  room,
  onRoomSaved,
  onClearedPresence,
  onSaved,
  onHold,
  onCancelHold,
  onClose,
}: {
  /** The room as a targets level, with its zone (and building) above it. */
  level: TargetLevel;
  /** Null when the home's layout could not be read: no targets to show. */
  house: House | null;
  temp: number | null;
  held: boolean;
  /** What the room is doing or following right now, in a sentence. */
  status: string;
  /** The room as its zone's cycle reports it, when it is part of one. */
  active?: ZoneStatus["rooms"][number];
  /** The room itself, for its occupied temperature. */
  room?: Room;
  onRoomSaved: (saved: Room) => void;
  /** Occupancy was cleared: read the Dashboard again. */
  onClearedPresence: () => void;
  onSaved: (house: House) => void;
  onHold: () => void;
  onCancelHold: () => void;
  onClose: () => void;
}) {
  const { fmtTemp, toDisplay, unitLabel } = useUnit();
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
  const range = (heat: number, cool: number | null | undefined) =>
    cool == null || cool === heat
      ? fmtTemp(heat)
      : `${toDisplay(heat)} to ${toDisplay(cool)}${unitLabel}`;
  const above = house ? effective(house, level.parent) : null;
  const unoccupied = house ? targetsFor(house, "unoccupied", level.id) : null;
  const unoccupiedLevel: TargetLevel = {
    scope: "unoccupied",
    id: level.id,
    name: `${level.name} when unoccupied`,
    parent: level,
  };
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
          <section className="room-details-block" aria-label="Baseline temperature target">
            <h4 className="room-details-title">Baseline Temperature Target</h4>
            <p className="field-help">
              {`${
                above
                  ? `Leave empty to follow ${above.from.name}: ${range(above.heat, above.cool)}.`
                  : "Leave empty and the room is kept at nothing in particular."
              } A hold, a schedule or occupancy comes first.`}
            </p>
            <TargetsRow house={house} level={level} onSaved={onSaved} bare />
          </section>
        )}

        {room && (
          <Collapsible
            title="When Occupied"
            value={
              room.system_wide_temp != null
                ? range(room.system_wide_temp, room.presence_cool_to)
                : "Not set"
            }
          >
            <p className="field-help">
              While someone is in the room. Leave empty and occupancy does not change its
              temperature.
            </p>
            <OccupiedTargets room={room} onSaved={onRoomSaved} />
          </Collapsible>
        )}

        {house && (
          <Collapsible
            title="When Unoccupied"
            value={unoccupied ? range(unoccupied.heat, unoccupied.cool) : "Not set"}
          >
            <p className="field-help">
              While its occupancy sensors see nobody. Leave empty and the room keeps its baseline.
            </p>
            <TargetsRow house={house} level={unoccupiedLevel} onSaved={onSaved} bare />
          </Collapsible>
        )}

        <section className="room-details-block room-details-row" aria-label="Hold">
          <div>
            <h4 className="room-details-title">Hold</h4>
            <p className="field-help">
              {held
                ? "On hold: kept at one temperature, ahead of everything else, until the hold ends."
                : "One temperature for 1 to 8 hours, ahead of everything else."}
            </p>
          </div>
          {held ? (
            <button type="button" className="btn btn-outline-danger" onClick={onCancelHold}>
              Cancel Hold
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={onHold}>
              Start a Hold
            </button>
          )}
        </section>

        {active?.presence_active && (
          <section className="room-details-block room-details-row" aria-label="Occupancy">
            <div>
              <h4 className="room-details-title">Occupancy</h4>
              <p className="field-help">
                Someone was seen here. Clear it to end its occupied targets now.
              </p>
              {error && <p className="form-error">{error}</p>}
            </div>
            <button
              type="button"
              className="btn btn-outline-danger"
              onClick={clearPresence}
              disabled={clearing}
            >
              {clearing ? "Clearing…" : "Clear Presence"}
            </button>
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
                  <EntityName id={eid} />
                  <span>
                    <span className={`vent-dot ${state}`} /> {state === "open" ? "Open" : "Closed"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
