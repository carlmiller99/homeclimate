import { useState } from "react";
import { setRoomSwitches, type House, type RoomSwitches } from "../houseApi";

const ROWS: { key: keyof RoomSwitches; title: string; on: string; off: string }[] = [
  {
    key: "in_use",
    title: "Room In Use",
    on: "The room is heated and cooled as usual.",
    off: "The room asks for no heating or cooling, and its schedules and occupancy sensors are ignored. A hold still works, and its safety limits still apply.",
  },
  {
    key: "use_schedules",
    title: "Follow Its Schedules",
    on: "A schedule gives the room its own target while it is active.",
    off: "The room's schedules are skipped, not deleted. It follows its targets instead.",
  },
  {
    key: "use_presence",
    title: "Follow Occupancy",
    on: "When someone is in the room it gets its occupied target.",
    off: "Occupancy sets no target. The room follows its targets instead.",
  },
];

/** What one room follows. Each switch saves as it is flipped. */
export default function RoomFollowDialog({
  roomId,
  roomName,
  switches,
  calendar,
  onSaved,
  onClose,
}: {
  roomId: string;
  roomName: string;
  switches: RoomSwitches;
  /** The calendar this room's In Use follows, if any: then it can't be set by hand. */
  calendar?: string | null;
  onSaved: (house: House) => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flip = async (key: keyof RoomSwitches) => {
    setError(null);
    setSaving(true);
    try {
      onSaved(await setRoomSwitches(roomId, { [key]: !switches[key] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the change");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="room-follow-title">
        <div className="modal-title" id="room-follow-title">{`What ${roomName} Follows`}</div>
        {ROWS.map((row) => {
          const on = switches[row.key];
          // Not in use, nothing else applies.
          const moot = row.key !== "in_use" && !switches.in_use;
          const byCalendar = row.key === "in_use" && Boolean(calendar);
          return (
            <div className="rule-row" key={row.key}>
              <input
                id={`room-follow-${row.key}`}
                className="switch"
                type="checkbox"
                role="switch"
                checked={on}
                aria-label={row.title}
                disabled={saving || moot || byCalendar}
                onChange={() => void flip(row.key)}
              />
              <div className="rule-text">
                <span className="rule-title">{row.title}</span>
                <p className="rule-help">
                  {moot ? "Not used while the room is not in use." : on ? row.on : row.off}
                  {byCalendar && ` Set by ${calendar}; change it in Smart Control, Schedules.`}
                </p>
              </div>
            </div>
          );
        })}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
