import { useEffect, useState } from "react";
import { useTimeZone, useUnit } from "../contexts";
import { Frozen } from "../ci";
import { ZoneHint } from "../components/Time";
import { RuleRow } from "../components/SmartControlControls";
import {
  DAY_LABELS,
  DEPTH_CHOICES,
  LEAD_CHOICES,
  describePeak,
  getPeakHours,
  updatePeakHours,
  type PeakHours,
  type PeakSettings,
} from "../peakApi";

/**
 * A time that is saved when the field is left (or Enter is pressed), not on
 * every change: browsers report a time one segment at a time while it is typed.
 * Never disabled, so typing is not cut off by a save elsewhere on the card.
 */
function TimeField({
  id,
  label,
  value,
  onCommit,
}: {
  id?: string;
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Re-derive when the saved value changes, during render (pitfall #9).
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft && draft !== value) onCommit(draft);
  };
  return (
    <input
      type="time"
      id={id}
      className="form-control"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/** Smart Control → Peak Hours: bank heat or cool ahead of the dearest hours. */
export default function PeakSection() {
  const { unit, unitLabel, toDisplayDelta } = useUnit();
  const tz = useTimeZone();
  const [data, setData] = useState<PeakHours | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPeakHours()
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

  const set = async (patch: Partial<PeakSettings>) => {
    setErr(null);
    setBusy(true);
    try {
      setData(await updatePeakHours(patch));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  if (loadFailed) return <p className="form-error">Could not load Peak Hours.</p>;
  if (!data) return <p className="page-subtitle">Loading Peak Hours…</p>;

  const shown = Number(toDisplayDelta(data.peak_depth).toFixed(1));
  const depths: number[] = [...DEPTH_CHOICES[unit]];
  if (!depths.includes(shown)) depths.push(shown);
  depths.sort((a, b) => a - b);
  const leads: number[] = [...LEAD_CHOICES];
  if (!leads.includes(data.lead_min)) leads.push(data.lead_min);
  leads.sort((a, b) => a - b);
  const toggleDay = (day: number) =>
    void set({
      days: data.days.includes(day) ? data.days.filter((d) => d !== day) : [...data.days, day],
    });

  return (
    <div className="card">
      <h3 className="card-title">Peak Hours</h3>
      <p className="sc-section-lead">
        If your electricity costs more at certain hours, HomeClimate can do some of the heating or
        cooling just before them. Rooms that follow a band are worked a little way into it ahead of
        the peak, so they can drift back across it before anything has to run. It never goes past
        the band, never touches a hold, and only acts when the forecast for those hours calls for
        it.
      </p>
      <p className="shade-why" role="status">
        <Frozen>{describePeak(data, (iso) => tz.format(iso))}</Frozen>
      </p>
      <RuleRow
        id="peak-enabled"
        title="Bank Ahead of Peak Hours"
        help="Off until you turn it on. It needs rooms that follow a band: targets that are not the same number, or a schedule or occupancy target with a Cool To."
        enabled={data.enabled}
        onToggle={(v) => void set({ enabled: v })}
      >
        {null}
      </RuleRow>
      <RuleRow
        id="peak-hours"
        title="The Peak Hours"
        help="When electricity costs most, in the house's time. An end earlier than the start runs into the next day."
      >
        <TimeField
          id="peak-hours-min"
          label="Peak starts"
          value={data.start}
          onCommit={(start) => void set({ start })}
        />
        <TimeField
          id="peak-hours-end"
          label="Peak ends"
          value={data.end}
          onCommit={(end) => void set({ end })}
        />
        <ZoneHint />
      </RuleRow>
      <fieldset className="notify-categories" disabled={busy}>
        <legend>On These Days</legend>
        {DAY_LABELS.map((label, day) => (
          <label key={label}>
            <input
              type="checkbox"
              checked={data.days.includes(day)}
              onChange={() => toggleDay(day)}
            />{" "}
            {label}
          </label>
        ))}
      </fieldset>
      <RuleRow
        id="peak-lead"
        title="Start Banking"
        help="How long before the peak begins to start. Longer suits a slow house; shorter wastes less."
      >
        <select
          className="form-control"
          id="peak-lead-min"
          aria-label="Start banking"
          value={data.lead_min}
          disabled={busy}
          onChange={(e) => void set({ lead_min: Number(e.target.value) })}
        >
          {leads.map((m) => (
            <option key={m} value={m}>
              {m} minutes before
            </option>
          ))}
        </select>
      </RuleRow>
      <RuleRow
        id="peak-depth"
        title={`How Far to Bank (${unitLabel})`}
        help="How far inside the band's edge to take a room: cooler than its Cool To before a hot peak, warmer than its Heat To before a cold one. Always at least a degree short of the band's other edge."
      >
        <select
          className="form-control"
          id="peak-depth-min"
          aria-label="How far to bank"
          value={shown}
          disabled={busy}
          onChange={(e) => void set({ peak_depth: Number(e.target.value) })}
        >
          {depths.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </RuleRow>
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}
