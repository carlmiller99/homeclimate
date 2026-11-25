import { useEffect, useState } from "react";
import { Frozen } from "../ci";
import { useTimeZone, useUnit } from "../contexts";
import { describeEvent, describeNeeds, getToday, type Today } from "../todayApi";

const REFRESH_MS = 5 * 60_000;
const NEED_WORD = { heat: "heating", cool: "cooling", coast: "coasting" } as const;

/**
 * Dashboard: what the weather asks of the house over the next day, what is
 * coming up on the clock, and yesterday in a sentence. Shows; changes nothing.
 */
export default function TodayCard() {
  const { fmtTemp } = useUnit();
  const tz = useTimeZone();
  const [data, setData] = useState<Today | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getToday()
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setLoadFailed(false);
          }
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
  const temps = data?.hours.map((h) => h.temp) ?? [];

  return (
    <div className="card today-card" data-testid="today-card">
      <h3 className="card-title">Today's Plan</h3>
      {loadFailed && !data && <p className="form-error">Could not load today's plan.</p>}
      {!loadFailed && !data && <p className="page-subtitle">Loading today's plan…</p>}
      {data && (
        <Frozen frozen={<p className="page-subtitle">—</p>}>
          {data.hours.length === 0 ? (
            <p className="page-subtitle">
              No forecast yet. Choose a weather source under Smart Control, Forecasts, to see what
              the next day asks for.
            </p>
          ) : (
            <>
              <p className="page-subtitle">
                {`Next ${data.hours.length} hours: ${describeNeeds(data.hours)}. Outside ${fmtTemp(Math.min(...temps))} to ${fmtTemp(Math.max(...temps))}.`}
              </p>
              <div
                className="today-strip"
                role="img"
                aria-label={`Hour by hour: ${describeNeeds(data.hours)}`}
              >
                {data.hours.map((h, i) => (
                  <span
                    key={h.at}
                    className={`today-hour today-${h.need}`}
                    title={`${hour(h.at)}: ${fmtTemp(h.temp)} outside, ${NEED_WORD[h.need]}`}
                  >
                    {i % 6 === 0 && <span className="today-hour-label">{hour(h.at)}</span>}
                  </span>
                ))}
              </div>
              <p className="form-hint">
                {`Heating when it is colder than ${fmtTemp(data.heat_below)} outside, cooling when warmer than ${fmtTemp(data.cool_above)}: the house band.`}
              </p>
            </>
          )}
          {data.events.length > 0 && (
            <ul className="today-events" aria-label="Coming up">
              {data.events.map((e) => (
                <li key={`${e.kind}-${e.at}-${e.room_id ?? ""}`} title={tz.tooltip(e.at)}>
                  <span className="today-when">{clock(e.at)}</span>
                  <span>{describeEvent(e, fmtTemp)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="shade-why">{data.yesterday}</p>
        </Frozen>
      )}
    </div>
  );
}
