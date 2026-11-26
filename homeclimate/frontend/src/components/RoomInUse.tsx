import { useState } from "react";
import { type Room } from "../api";
import {
  calendarFor,
  clearRoomCalendar,
  LEAD_MAX_MIN,
  setRoomCalendar,
  setRoomSwitches,
  switchesFor,
  type House,
  type RoomCalendar,
} from "../houseApi";
import EntityPicker from "./EntityPicker";
import { MinutesInput } from "./SmartControlControls";

type Mode = "always" | "calendar" | "never";

const MODES: [Mode, string][] = [
  ["always", "Always"],
  ["calendar", "When a Calendar Says So"],
  ["never", "Never"],
];

/**
 * Smart Control → Schedules, top of a room's card: whether the room is in
 * use. Always, never, or while a Home Assistant calendar has an event on. A
 * room that is not in use asks for no heating or cooling, and its time
 * blocks and occupancy sensors are ignored.
 */
export default function RoomInUse({
  room,
  house,
  onHouse,
}: {
  room: Room;
  house: House;
  onHouse: (h: House) => void;
}) {
  const calendar = calendarFor(house, room.id);
  const inUse = switchesFor(house, room.id).in_use;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // "When a Calendar Says So" was chosen and no calendar has been picked yet.
  const [picking, setPicking] = useState(false);
  // Bumped when a save is refused: drafts go back to what is stored.
  const [attempt, setAttempt] = useState(0);
  const stored = calendar?.match_text ?? "";
  const [match, setMatch] = useState(stored);
  const [shown, setShown] = useState({ stored, attempt });
  if (shown.stored !== stored || shown.attempt !== attempt) {
    setShown({ stored, attempt });
    setMatch(stored);
  }
  const mode: Mode = calendar || picking ? "calendar" : inUse ? "always" : "never";

  // Every control here is disabled while a change is being saved, so one runs at a time.
  const run = async (call: () => Promise<House>) => {
    setErr(null);
    setBusy(true);
    try {
      onHouse(await call());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the change");
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const choose = (next: Mode) => {
    if (next === mode) return;
    if (next === "calendar") {
      setPicking(true);
      return;
    }
    setPicking(false);
    const want = next === "always";
    void run(async () => {
      // A calendar sets In Use itself, so it goes first.
      let h = house;
      if (calendar) {
        h = await clearRoomCalendar(room.id);
        // Shown at once: if the next step is refused, the room has still
        // stopped following its calendar, and a retry must not clear it again.
        onHouse(h);
      }
      if (switchesFor(h, room.id).in_use !== want) {
        h = await setRoomSwitches(room.id, { in_use: want });
      }
      return h;
    });
  };
  const save = (data: Partial<RoomCalendar>) => void run(() => setRoomCalendar(room.id, data));

  return (
    <div className="room-in-use">
      <div className="room-in-use-row">
        <span className="field-label" id={`in-use-${room.id}`}>
          This room is in use
        </span>
        <div className="segmented" role="radiogroup" aria-label={`${room.name} is in use`}>
          {MODES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className="segmented-option"
              disabled={busy}
              onClick={() => choose(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {calendar && (
          <span className={calendar.unreadable ? "fireplace-note" : "shade-why"} role="status">
            {calendar.unreadable
              ? "This calendar isn't answering, so the room is being treated as in use."
              : inUse
                ? "In use now"
                : "Not in use now"}
          </span>
        )}
      </div>
      {mode === "never" && (
        <p className="field-help">
          Not in use: only a hold or its safety limits heat or cool this room. Its time blocks are
          kept for when it is used again.
        </p>
      )}
      {mode === "calendar" &&
        (calendar ? (
          <div className="calendar-fields">
            <div className="field-stack">
              <span className="field-label">Calendar</span>
              <span className="picked-entity">
                <span>{calendar.entity_id}</span>
              </span>
            </div>
            <label className="field-stack">
              Only Events Containing
              <input
                className="form-control"
                value={match}
                maxLength={60}
                placeholder="Any event"
                disabled={busy}
                onChange={(e) => setMatch(e.target.value)}
                onBlur={() => {
                  if (match.trim() !== stored) save({ match_text: match.trim() });
                  else setMatch(stored);
                }}
              />
            </label>
            <div className="field-stack">
              <span className="field-label">Get Ready Ahead</span>
              <MinutesInput
                key={attempt}
                value={calendar.lead_min}
                min={0}
                max={LEAD_MAX_MIN}
                label={`Minutes ahead for ${room.name}`}
                disabled={busy}
                onCommit={(n) => save({ lead_min: n })}
              />
            </div>
          </div>
        ) : (
          <div className="calendar-fields">
            <EntityPicker
              domain="calendar"
              placeholder="Choose a calendar…"
              onSelect={(id) => {
                setPicking(false);
                save({ entity_id: id });
              }}
            />
            <p className="field-help">
              The room is in use while an event is on, and from a set time before one starts so it
              is ready on arrival.
            </p>
          </div>
        ))}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}
