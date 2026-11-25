import { useEffect, useState } from "react";
import { getRooms, type Room } from "../api";
import EntityPicker from "../components/EntityPicker";
import { MinutesInput } from "../components/SmartControlControls";
import {
  calendarFor,
  clearRoomCalendar,
  getHouse,
  LEAD_MAX_MIN,
  setRoomCalendar,
  switchesFor,
  type House,
  type RoomCalendar,
} from "../houseApi";

function CalendarRow({
  room,
  calendar,
  inUse,
  busy,
  attempt,
  onSave,
  onClear,
}: {
  room: Room;
  calendar: RoomCalendar | null;
  inUse: boolean;
  busy: boolean;
  /** Bumped when a save is refused: drafts go back to what is stored. */
  attempt: number;
  onSave: (roomId: string, data: Partial<RoomCalendar>) => void;
  onClear: (roomId: string) => void;
}) {
  const stored = calendar?.match_text ?? "";
  const [match, setMatch] = useState(stored);
  const [shown, setShown] = useState({ stored, attempt });
  if (shown.stored !== stored || shown.attempt !== attempt) {
    // The stored text changed, or a save was refused: show what is stored.
    setShown({ stored, attempt });
    setMatch(stored);
  }
  return (
    <div className="calendar-row" role="group" aria-label={room.name}>
      <div className="calendar-room">
        <span className="sensor-title">{room.name}</span>
        {calendar && <span className="shade-why">{inUse ? "In use now" : "Not in use now"}</span>}
      </div>
      {calendar ? (
        <div className="calendar-fields">
          <div className="picked-entity">
            <span>{calendar.entity_id}</span>
            <button
              type="button"
              className="link-button"
              aria-label={`Stop ${room.name} following a calendar`}
              disabled={busy}
              onClick={() => onClear(room.id)}
            >
              Stop Following
            </button>
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
                if (match.trim() !== stored) onSave(room.id, { match_text: match.trim() });
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
              onCommit={(n) => onSave(room.id, { lead_min: n })}
            />
          </div>
        </div>
      ) : (
        <EntityPicker
          domain="calendar"
          placeholder="Follow a calendar…"
          onSelect={(id) => onSave(room.id, { entity_id: id })}
        />
      )}
    </div>
  );
}

/** Smart Control → Schedules: rooms whose "in use" follows a Home Assistant calendar. */
export default function RoomCalendarsCard() {
  const [house, setHouse] = useState<House | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getHouse(), getRooms()])
      .then(([h, r]) => {
        if (cancelled) return;
        setHouse(h);
        setRooms([...r].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (call: () => Promise<House>) => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      setHouse(await call());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the change");
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sc-section" id="room-calendars">
      <h2 className="sc-section-title">Rooms In Use by Calendar</h2>
      <p className="sc-section-lead">
        A room can follow a Home Assistant calendar: it is in use while an event is on, and from a
        set time before one starts so it is ready on arrival. The rest of the time it asks for no
        heating or cooling and its schedules and occupancy sensors are ignored.
      </p>
      {loadFailed && <p className="form-error">Could not load rooms and calendars.</p>}
      {!loadFailed && !house && <p className="page-subtitle">Loading rooms…</p>}
      {err && <p className="form-error">{err}</p>}
      {house &&
        rooms.map((room) => (
          <CalendarRow
            key={room.id}
            room={room}
            calendar={calendarFor(house, room.id)}
            inUse={switchesFor(house, room.id).in_use}
            busy={busy}
            attempt={attempt}
            onSave={(id, data) => void run(() => setRoomCalendar(id, data))}
            onClear={(id) => void run(() => clearRoomCalendar(id))}
          />
        ))}
      {house && rooms.length === 0 && <p className="page-subtitle">Add rooms in My Home first.</p>}
    </section>
  );
}
