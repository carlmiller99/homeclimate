import { useEffect, useState } from "react";
import { Frozen } from "../ci";
import EntityPicker from "../components/EntityPicker";
import { RuleRow } from "../components/SmartControlControls";
import Time from "../components/Time";
import { useTimeZone, useUnit } from "../contexts";
import { todayInZone } from "../time";
import {
  accuracyText,
  dayPlan,
  dayType,
  describeCondition,
  getForecast,
  refreshForecast,
  updateForecastSettings,
  type Forecast,
  type ForecastSettings,
} from "../forecastApi";

const STATE_TEXT: Record<Forecast["state"], string> = {
  off: "The forecast is off.",
  no_entity: "Choose a weather source to start fetching the forecast.",
  none: "No forecast yet.",
  kept: "Showing the last forecast received.",
  fresh: "Up to date.",
};

export default function ForecastSection() {
  const { fmtTemp, toDisplayDelta, unitLabel } = useUnit();
  const tz = useTimeZone();
  const [data, setData] = useState<Forecast | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getForecast()
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

  if (loadFailed) return <p className="form-error">Could not load the forecast.</p>;
  if (!data) return <p className="page-subtitle">Loading the forecast…</p>;

  const run = async (call: () => Promise<Forecast>, fallback: string) => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      setData(await call());
    } catch (e) {
      setErr(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<ForecastSettings>) =>
    void run(() => updateForecastSettings(patch), "Could not save the setting");
  const s = data.settings;
  const showing = data.state === "fresh" || data.state === "kept";

  return (
    <>
      <section className="sc-section" id="forecasts">
        <h2 className="sc-section-title">Forecasts</h2>
        <p className="sc-section-lead">
          HomeClimate fetches the hourly forecast and keeps a record of it. Its one use in control
          so far is Auto Mode, when a building heats or cools as one.
        </p>
        <RuleRow
          id="forecast-enabled"
          title="Use the Weather Forecast"
          help="Fetches the hourly forecast from Home Assistant every 30 minutes."
          enabled={s.enabled}
          onToggle={(v) => set({ enabled: v })}
        >
          {null}
        </RuleRow>
        <div className="rule-row">
          <span className="switch-spacer" />
          <div className="rule-text">
            <span className="rule-title">Weather Source</span>
            <p className="rule-help">
              {data.shared_with_shades
                ? "Using the weather source set for Shades. Choose one here to use a different one."
                : "A Home Assistant weather entity with an hourly forecast."}
            </p>
          </div>
          <div className="rule-value">
            {s.weather_entity ? (
              <div className="picked-entity">
                <span>{s.weather_entity}</span>
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => set({ weather_entity: "" })}
                >
                  Clear
                </button>
              </div>
            ) : (
              <>
                {data.shared_with_shades && (
                  <span className="picked-entity">{data.weather_entity}</span>
                )}
                <EntityPicker
                  domain="weather"
                  placeholder="Search weather…"
                  onSelect={(id) => set({ weather_entity: id })}
                />
              </>
            )}
          </div>
        </div>
        <RuleRow
          id="forecast-correct"
          title="Correct the Forecast From Experience"
          help="Compares each hour's forecast with your outside temperature sensor and, once it knows how far off the forecast usually is at that time of day, adjusts for it."
          enabled={s.correct}
          onToggle={(v) => set({ correct: v })}
        >
          {null}
        </RuleRow>
        <p className="rule-help forecast-accuracy" role="status">
          {accuracyText(data.accuracy, toDisplayDelta, unitLabel)}
        </p>
        {err && <p className="form-error">{err}</p>}
      </section>

      <section className="sc-section" id="forecast-now">
        <div className="sc-section-head">
          <h2 className="sc-section-title">The Forecast</h2>
          {data.state !== "off" && data.state !== "no_entity" && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void run(refreshForecast, "Could not fetch the forecast")}
            >
              Fetch Now
            </button>
          )}
        </div>
        <p className="sc-section-lead">
          {STATE_TEXT[data.state]}{" "}
          <Frozen frozen={null}>
            {showing && data.fetched_at && (
              <>
                Received <Time value={data.fetched_at} />.
              </>
            )}
          </Frozen>
        </p>
        {data.problem && <p className="form-error">{data.problem}</p>}
        {showing && (
          <>
            <ul className="forecast-days" aria-label="Outlook">
              {data.days.map((d) => {
                const type = dayType(d.runs);
                const hour = (at: string) => tz.format(at, "time", { hour: "numeric" });
                return (
                  <li key={d.date} className="forecast-day">
                    <div className="forecast-day-head">
                      <strong>
                        {d.date === todayInZone(tz.zone) ? (
                          "Today"
                        ) : (
                          <Time value={d.starts_at} kind="date" options={{ weekday: "long" }} />
                        )}
                      </strong>
                      <span className={`forecast-chip forecast-${type.toLowerCase()}`}>{type}</span>
                    </div>
                    <div className="forecast-range">
                      {`${fmtTemp(d.low)} to ${fmtTemp(d.high)}`}
                    </div>
                    <div className="forecast-sky">{describeCondition(d.condition) || "—"}</div>
                    <div className="forecast-bar" aria-hidden="true">
                      {d.runs.map((r) => (
                        <span
                          key={r.at}
                          className={`forecast-${r.need}`}
                          style={{ flexGrow: r.hours }}
                        />
                      ))}
                    </div>
                    <div className="forecast-plan">{dayPlan(d.runs, hour)}</div>
                  </li>
                );
              })}
            </ul>
            <details className="forecast-table">
              <summary>{`Hour by hour, next ${data.hours.length} hours`}</summary>
              <table className="forecast-hours" aria-label={`Next ${data.hours.length} hours`}>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Temperature</th>
                    <th scope="col">Sky</th>
                    <th scope="col">Cloud Cover</th>
                    <th scope="col">Chance of Rain</th>
                  </tr>
                </thead>
                <tbody>
                  {data.hours.map((h) => (
                    <tr key={h.at}>
                      <th scope="row">
                        <Time value={h.at} kind="time" options={{ hour: "numeric" }} />
                      </th>
                      <td>{fmtTemp(h.temp)}</td>
                      <td>{describeCondition(h.condition) || "—"}</td>
                      <td>{h.cloud_pct === null ? "—" : `${h.cloud_pct}%`}</td>
                      <td>{h.precip_pct === null ? "—" : `${h.precip_pct}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </section>
    </>
  );
}
