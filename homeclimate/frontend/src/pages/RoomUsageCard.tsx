import { useEffect, useState } from "react";
import { createSchedule, getRooms, type Room } from "../api";
import { HouseTime } from "../components/Time";
import { useUnit } from "../contexts";
import {
  describeDays,
  getSuggestions,
  type RoomSuggestion,
  type Suggestions,
} from "../suggestionsApi";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One room's week: a row a day, a cell an hour, darker where it is used more. */
function Strip({ name, usage }: { name: string; usage: number[][] }) {
  return (
    <div className="usage-strip" role="img" aria-label={`When ${name} is used, hour by hour`}>
      {usage.map((day, d) => (
        <div className="usage-day" key={DAYS[d]}>
          <span className="usage-label">{DAYS[d]}</span>
          {day.map((pct, h) => (
            <span
              key={h}
              className="usage-cell"
              style={{ opacity: pct === 0 ? 0.06 : 0.15 + (0.85 * pct) / 100 }}
            />
          ))}
        </div>
      ))}
      <div className="usage-day usage-hours" aria-hidden="true">
        <span className="usage-label" />
        <span>Midnight</span>
        <span>6 AM</span>
        <span>Noon</span>
        <span>6 PM</span>
      </div>
    </div>
  );
}

/** Turning a room's usual hours into schedule blocks, at a temperature the user confirms. */
function MakeSchedule({
  suggestion,
  room,
  onDone,
}: {
  suggestion: RoomSuggestion;
  room: Room | undefined;
  onDone: () => void;
}) {
  const { toDisplay, displayBound, unitLabel } = useUnit();
  const [temp, setTemp] = useState(
    room?.system_wide_temp != null ? String(toDisplay(room.system_wide_temp)) : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const count = suggestion.blocks.length;

  const add = async () => {
    const value = parseFloat(temp);
    const lo = displayBound(40, "min");
    const hi = displayBound(90, "max");
    if (isNaN(value) || value < lo || value > hi) {
      setError(
        `Use a temperature from ${lo.toFixed(1)}${unitLabel} to ${hi.toFixed(1)}${unitLabel}.`
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      for (const b of suggestion.blocks) {
        // The temperature is sent as typed; the backend converts it.
        await createSchedule(suggestion.room_id, {
          days_of_week: b.days,
          start_time: b.start,
          end_time: b.end,
          target_temp: value,
          enabled: true,
          expires_at: null,
          name: "Usual hours",
        });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the schedule");
      setSaving(false);
    }
  };

  return (
    <div className="usage-make">
      <label className="occupied-field">
        <span>{`Temperature (${unitLabel})`}</span>
        <input
          className="form-control"
          type="number"
          step="0.5"
          value={temp}
          disabled={saving}
          onChange={(e) => setTemp(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="btn btn-primary"
        disabled={saving}
        onClick={() => void add()}
      >
        {saving ? "Adding…" : `Add ${count} ${count === 1 ? "Block" : "Blocks"}`}
      </button>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

/** Smart Control → Smart Learning → When Rooms Are Used. */
export default function RoomUsageCard() {
  const [data, setData] = useState<Suggestions | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [failed, setFailed] = useState(false);
  const [making, setMaking] = useState<string | null>(null);
  const [made, setMade] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSuggestions(), getRooms()])
      .then(([s, r]) => {
        if (cancelled) return;
        setData(s);
        setRooms(r);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = (data?.rooms ?? []).filter((r) => r.usage);
  return (
    <div className="card">
      <h3 className="card-title">When Rooms Are Used</h3>
      <p className="page-subtitle">
        From each room&rsquo;s occupancy sensors over the last month. Darker means used more often.
      </p>
      {failed && <p className="form-error">Could not load when rooms are used.</p>}
      {!failed && !data && <p className="page-subtitle">Looking at the history…</p>}
      {data && shown.length === 0 && (
        <p className="page-subtitle">
          {`Nothing yet. A room appears after ${data.min_days} days of readings from an occupancy sensor.`}
        </p>
      )}
      {shown.map((r) => (
        <div key={r.room_id} className="usage-room" role="group" aria-label={r.name}>
          <span className="sensor-title">{r.name}</span>
          <Strip name={r.name} usage={r.usage!} />
          {r.blocks.length === 0 ? (
            <span className="shade-why">No regular hours yet.</span>
          ) : (
            <>
              <ul className="learning-rooms">
                {r.blocks.map((b) => (
                  <li key={`${b.days.join("")}-${b.start}`}>
                    {describeDays(b.days)}, <HouseTime>{b.start}</HouseTime> to{" "}
                    <HouseTime>{b.end}</HouseTime>
                  </li>
                ))}
              </ul>
              {made.includes(r.room_id) ? (
                <span className="shade-why" role="status">
                  Added. Change them under Schedules.
                </span>
              ) : making === r.room_id ? (
                <MakeSchedule
                  suggestion={r}
                  room={rooms.find((x) => x.id === r.room_id)}
                  onDone={() => {
                    setMaking(null);
                    setMade((m) => [...m, r.room_id]);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  aria-label={`Make ${r.name}'s usual hours a schedule`}
                  onClick={() => setMaking(r.room_id)}
                >
                  Make This a Schedule
                </button>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
