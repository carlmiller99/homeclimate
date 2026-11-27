import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useUnit } from "../contexts";
import { describeDeadband, getSuggestions, type Suggestions } from "../suggestionsApi";

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
      {data && data.zones.length === 0 && (
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
    </div>
  );
}
