import { useEffect, useState } from "react";
import { Link, useInRouterContext } from "react-router";
import { Frozen } from "../ci";
import { useTimeZone, useUnit } from "../contexts";
import { describeEvent, describeNeeds, describeRuns, getToday, type Today } from "../todayApi";

const REFRESH_MS = 5 * 60_000;
const NEED_WORD = { heat: "heating", cool: "cooling", coast: "coasting" } as const;
const RUN_LABEL = { heat: "Heating", cool: "Cooling", coast: "Coasting" } as const;
// The outdoor line is drawn in a fixed box and stretched to the card's width.
const W = 720;
const H = 70;
const PAD = 10;
const TUNE = "/smart-control?section=forecasts";

/**
 * Dashboard: what the weather asks of the house over the next day, what is
 * coming up on the clock, and yesterday in a sentence. Shows; changes nothing.
 */
export default function TodayCard() {
  const { fmtTemp } = useUnit();
  const tz = useTimeZone();
  const [data, setData] = useState<Today | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const routed = useInRouterContext();

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getToday()
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch(() => {
          if (!cancelled) setLoadFailed(true);
        });
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const hour = (at: string) => tz.format(at, "time", { hour: "numeric" });
  const clock = (at: string) => tz.format(at, "time", { hour: "numeric", minute: "2-digit" });
  const hours = data?.hours ?? [];
  const temps = hours.map((h) => h.temp);
  const low = Math.min(...temps);
  const high = Math.max(...temps);
  const lowAt = temps.indexOf(low);
  const highAt = temps.indexOf(high);
  // Consecutive hours that ask for the same thing are one block of the band.
  const runs: { need: Today["hours"][number]["need"]; at: string; count: number }[] = [];
  for (const h of hours) {
    const last = runs[runs.length - 1];
    if (last && last.need === h.need) last.count += 1;
    else runs.push({ need: h.need, at: h.at, count: 1 });
  }
  const span = Math.max(hours.length - 1, 1);
  const x = (i: number) => (i / span) * W;
  const y = (t: number) =>
    high === low ? H / 2 : H - PAD - ((t - low) / (high - low)) * (H - 2 * PAD);
  // About seven evenly spaced times under the line, the first one being now.
  const step = Math.max(1, Math.round(span / 6));
  const ticks = hours.map((_, i) => i).filter((i) => i % step === 0);
  const nearest = (i: number) =>
    ticks.reduce((best, t) => (Math.abs(t - i) < Math.abs(best - i) ? t : best), 0);
  const marked = new Set([0, nearest(lowAt), nearest(highAt)]);

  return (
    <div className="card today-card" data-testid="today-card">
      <h3 className="card-title">Today's Plan</h3>
      {loadFailed && !data && <p className="form-error">Could not load today's plan.</p>}
      {!loadFailed && !data && <p className="page-subtitle">Loading today's plan…</p>}
      {data && (
        <Frozen frozen={<p className="page-subtitle">—</p>}>
          {hours.length === 0 ? (
            <p className="page-subtitle">
              No forecast yet. Choose a weather source under Smart Control, Forecasts, to see what
              the next day asks for.
            </p>
          ) : (
            <>
              <p className="today-lead">
                {`${describeRuns(hours, hour)} Low ${fmtTemp(low)}, high ${fmtTemp(high)}.`}
              </p>
              <div className="today-chart">
                <div
                  className="today-band"
                  role="img"
                  aria-label={`Next ${hours.length} hours: ${describeNeeds(hours)}`}
                >
                  {runs.map((r) => (
                    <span
                      key={r.at}
                      className={`today-run today-${r.need}`}
                      style={{ flexGrow: r.count }}
                      title={`${RUN_LABEL[r.need]} from ${hour(r.at)}, ${r.count} ${r.count === 1 ? "hour" : "hours"}`}
                    >
                      {/* A one-hour block is too narrow for its word. */}
                      {r.count > 1 && RUN_LABEL[r.need]}
                    </span>
                  ))}
                </div>
                <svg
                  className="today-line"
                  role="img"
                  aria-label={`Outside: ${fmtTemp(temps[0])} now, low ${fmtTemp(low)} at ${hour(hours[lowAt].at)}, high ${fmtTemp(high)} at ${hour(hours[highAt].at)}`}
                  viewBox={`0 0 ${W} ${H}`}
                  preserveAspectRatio="none"
                >
                  <polyline
                    points={hours
                      .map((h, i) => `${x(i).toFixed(1)},${y(h.temp).toFixed(1)}`)
                      .join(" ")}
                  />
                  <line className="today-now" x1="1" y1="0" x2="1" y2={H} />
                </svg>
                <div className="today-axis" aria-hidden="true">
                  {ticks.map((i) => (
                    <span
                      key={hours[i].at}
                      className={
                        i === 0 ? "is-first" : i === hours.length - 1 ? "is-last" : undefined
                      }
                      style={{ left: `${((i / span) * 100).toFixed(1)}%` }}
                      title={`${fmtTemp(hours[i].temp)} outside, ${NEED_WORD[hours[i].need]}`}
                    >
                      {i === 0 ? "Now" : hour(hours[i].at)}
                      {marked.has(i) && ` ${fmtTemp(hours[i].temp)}`}
                    </span>
                  ))}
                </div>
              </div>
              <p className="form-hint">
                {`Heating when it is colder than ${fmtTemp(data.heat_below)} outside, cooling when warmer than ${fmtTemp(data.cool_above)}: your targets.`}
              </p>
            </>
          )}
          {data.events.length > 0 && (
            <ul className="today-events" aria-label="Coming up">
              {data.events.map((e) => (
                <li key={`${e.kind}-${e.at}-${e.room_id ?? ""}`} title={tz.tooltip(e.at)}>
                  <strong className="today-when">{clock(e.at)}</strong>
                  <span>{describeEvent(e, fmtTemp)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="shade-why">{data.yesterday}</p>
          <p className="today-source">
            {data.forecast_fetched_at
              ? `Forecast updated ${clock(data.forecast_fetched_at)}. `
              : "No forecast has been read yet. "}
            {routed ? (
              <Link to={TUNE}>Tune in Smart Control</Link>
            ) : (
              <a href={TUNE}>Tune in Smart Control</a>
            )}
          </p>
        </Frozen>
      )}
    </div>
  );
}
