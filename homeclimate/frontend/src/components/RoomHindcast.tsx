import { useEffect, useState } from "react";
import { useTimeZone, useUnit } from "../contexts";
import { getHindcast, type Hindcast } from "../learningApi";

const W = 720;
const H = 160;
const PAD = 8;

/**
 * Smart Learning → a room → its chart: one day of measured temperature with
 * what the room's model said an hour ahead. The closer the lines, the more
 * the model can be trusted to time a warm-up.
 */
export default function RoomHindcast({ roomId, name }: { roomId: string; name: string }) {
  const { toDisplay, toDisplayDelta, fmtTemp, unitLabel } = useUnit();
  const tz = useTimeZone();
  const [data, setData] = useState<Hindcast | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getHindcast(roomId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  if (failed) return <p className="form-error">{`Could not load ${name}'s chart.`}</p>;
  if (!data) return <p className="sc-note">Loading the chart…</p>;
  if (data.points.length < 2)
    return <p className="sc-note">{`No readings for ${name} yesterday.`}</p>;

  const t0 = Date.parse(data.start);
  const span = Date.parse(data.end) - t0;
  const all = data.points.flatMap((p) =>
    p.predicted == null ? [p.measured] : [p.measured, p.predicted]
  );
  const low = Math.min(...all);
  // A flat day still needs a height to draw in.
  const range = Math.max(...all) - low || 1;
  const x = (at: string) => ((Date.parse(at) - t0) / span) * W;
  const y = (f: number) => H - PAD - ((f - low) / range) * (H - 2 * PAD);
  const line = (pts: { at: string; value: number }[]) =>
    pts.map((p) => `${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  // A line is broken where readings are missing, or where the model could
  // not say: it is never drawn across a gap it knows nothing about.
  const GAP_MS = 20 * 60 * 1000;
  const runsOf = (pts: { at: string; value: number | null }[]) => {
    const runs: { at: string; value: number }[][] = [];
    let last = -Infinity;
    for (const p of pts) {
      const when = Date.parse(p.at);
      if (p.value == null) {
        last = -Infinity;
        continue;
      }
      if (when - last > GAP_MS) runs.push([]);
      runs[runs.length - 1].push({ at: p.at, value: p.value });
      last = when;
    }
    return runs;
  };
  const draw = (runs: { at: string; value: number }[][], kind: string) =>
    runs.map((run) =>
      run.length === 1 ? (
        // One reading alone: a dot, since a line needs two. Drawn as a
        // line of no length with round ends, so it stays round however the
        // chart is stretched.
        <polyline
          key={run[0].at}
          className={`hindcast-dot hindcast-dot-${kind}`}
          points={line([run[0], run[0]])}
        />
      ) : (
        <polyline key={run[0].at} className={`hindcast-${kind}`} points={line(run)} />
      )
    );
  // Evenly spaced if the marks did not come with the day.
  const tick = (i: number) =>
    data.ticks?.length === 5 ? ((Date.parse(data.ticks[i]) - t0) / span) * 100 : i * 25;
  const measured = runsOf(data.points.map((p) => ({ at: p.at, value: p.measured })));
  const predicted = runsOf(data.points.map((p) => ({ at: p.at, value: p.predicted })));
  const miss =
    data.typical_miss == null
      ? "The model could not speak for this day yet."
      : `Typically ${toDisplayDelta(data.typical_miss)}${unitLabel} off, one hour ahead.`;
  return (
    <figure className="hindcast">
      <figcaption className="hindcast-title">
        {`${name}: predicted against measured, ${tz.format(data.start, "date")}`}
      </figcaption>
      <div className="hindcast-plot">
        <span className="hindcast-scale">
          <span>{fmtTemp(low + range)}</span>
          <span>{fmtTemp(low)}</span>
        </span>
        <svg
          className="hindcast-lines"
          role="img"
          aria-label={`${name} ranged from ${toDisplay(low)}${unitLabel} to ${toDisplay(low + range)}${unitLabel}. ${miss}`}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
        >
          {draw(measured, "measured")}
          {draw(predicted, "predicted")}
        </svg>
      </div>
      <div className="hindcast-axis" aria-hidden="true">
        {["Midnight", "6 AM", "Noon", "6 PM", "Midnight"].map((label, i) => (
          // Placed where the house's clock reads that hour, which is not
          // evenly spaced on a day the clocks change.
          <span
            key={i}
            style={{ left: `${tick(i)}%` }}
            data-edge={i === 0 ? "start" : i === 4 ? "end" : undefined}
          >
            {label}
          </span>
        ))}
      </div>
      <p className="hindcast-legend">
        <span className="hindcast-key hindcast-key-measured" /> Measured
        <span className="hindcast-key hindcast-key-predicted" /> Predicted an hour before
      </p>
      <p className="field-help">{miss}</p>
    </figure>
  );
}
