import { useState } from "react";
import { setRoomSwitches, type House, type RoomSwitches } from "../houseApi";

const ROWS: { key: "use_schedules" | "use_presence"; title: string; on: string; off: string }[] = [
  {
    key: "use_schedules",
    title: "Follow Its Schedules",
    on: "A schedule gives the room its own target while it is active.",
    off: "The room's schedules are skipped, not deleted. It follows its targets instead.",
  },
  {
    key: "use_presence",
    title: "Follow Occupancy",
    on: "When someone is in the room it gets its occupied targets.",
    off: "Occupancy sets no target. The room follows its targets instead.",
  },
];

/**
 * Smart Control → Rooms → a room: whether it follows its schedules and its
 * occupancy. Each switch saves as it is flipped. Room In Use sits beside it.
 */
export default function RoomFollowSwitches({
  roomId,
  switches,
  onSaved,
}: {
  roomId: string;
  switches: RoomSwitches;
  onSaved: (house: House) => void;
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
    <div>
      {ROWS.map((row) => {
        const on = switches[row.key];
        // Not in use, nothing else applies.
        const moot = !switches.in_use;
        return (
          <div className="rule-row" key={row.key}>
            <input
              id={`room-follow-${roomId}-${row.key}`}
              className="switch"
              type="checkbox"
              role="switch"
              checked={on}
              aria-label={row.title}
              disabled={saving || moot}
              onChange={() => void flip(row.key)}
            />
            <div className="rule-text">
              <span className="rule-title">{row.title}</span>
              <p className="rule-help">
                {moot ? "Not used while the room is not in use." : on ? row.on : row.off}
              </p>
            </div>
          </div>
        );
      })}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
