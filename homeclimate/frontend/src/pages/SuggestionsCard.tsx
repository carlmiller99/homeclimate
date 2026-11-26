import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useUnit } from "../contexts";
import { HouseTime } from "../components/Time";
import {
  describeDays,
  describeDeadband,
  getSuggestions,
  type Suggestions,
} from "../suggestionsApi";

/** Smart Control → Smart Learning: advice from recorded history. Changes nothing. */
export default function SuggestionsCard() {
  const { toDisplayDelta, unitLabel } = useUnit();
  const [data, setData] = useState<Suggestions | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSuggestions()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="card">
      <h3 className="card-title">Suggestions</h3>
      <p className="page-subtitle">
        Advice from what has been recorded. Nothing here changes a setting: each suggestion says
        what it rests on, and where to make the change if you agree.
      </p>
      {loadFailed && <p className="form-error">Could not load the suggestions.</p>}
      {!loadFailed && !data && <p className="page-subtitle">Looking at the history…</p>}
      {data && data.zones.length === 0 && data.rooms.length === 0 && (
        <p className="page-subtitle">
          Nothing to suggest. Suggestions need {data.min_days} days of history, and appear only when
          the history points to a change.
        </p>
      )}
      {data?.zones.map((z) => (
        <div key={z.thermostat_entity_id} className="calendar-row" role="group" aria-label={z.name}>
          <div className="calendar-room">
            <span className="sensor-title">{z.name}: a wider deadband</span>
            <span className="shade-why">{describeDeadband(z, toDisplayDelta, unitLabel)}</span>
            <span className="form-hint">
              Change it under <Link to="/my-home">My Home</Link>, Edit Zone.
            </span>
          </div>
        </div>
      ))}
      {data?.rooms.map((r) => (
        <div key={r.room_id} className="calendar-row" role="group" aria-label={r.name}>
          <div className="calendar-room">
            <span className="sensor-title">{r.name}: when it is usually in use</span>
            <span className="shade-why">
              From {r.days} days of its occupancy sensors, about {r.hours_a_week} hours a week.
            </span>
            <ul className="learning-rooms">
              {r.blocks.map((b) => (
                <li key={`${b.days.join("")}-${b.start}`}>
                  {describeDays(b.days)}, <HouseTime>{b.start}</HouseTime> to{" "}
                  <HouseTime>{b.end}</HouseTime>
                </li>
              ))}
            </ul>
            <span className="form-hint">
              Add blocks like these under{" "}
              <Link to="/smart-control?section=schedules">Schedules</Link> if they look right.
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
