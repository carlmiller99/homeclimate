import { useEffect, useRef, useState } from "react";
import { useUnit } from "../contexts";
import { Frozen } from "../ci";
import {
  BALANCE_LEVEL_LABELS,
  GAP_CHOICES,
  describeBalance,
  getZoneBalance,
  setZoneBalance,
  type BalanceBuilding,
  type BalanceLevel,
} from "../zoneBalanceApi";

const REFRESH_MS = 30_000;

const LEVEL_HELP: Record<BalanceLevel, string> = {
  off: "Off: zones are left to drift apart.",
  watch: "Watch Only: records what it would do, and does nothing.",
  on: "On: a zone that falls further behind than this is brought back to it.",
};

/**
 * A building's zones right now: each on a line from the coolest reading to the
 * warmest, so how far apart they are can be seen as well as read.
 */
function BalanceNow({
  building: b,
  fmtTemp,
  fmtDelta,
}: {
  building: BalanceBuilding;
  fmtTemp: (f: number) => string;
  fmtDelta: (f: number) => string;
}) {
  const temps = b.zones.map((z) => z.temp).filter((t): t is number => t !== null);
  const low = Math.min(...temps);
  const high = Math.max(...temps);
  // Half the line is always in use, so two zones a degree apart do not sit
  // at opposite ends of it.
  const span = Math.max(high - low, b.zone_gap);
  const mid = (high + low) / 2;
  const at = (t: number) => 50 + ((t - mid) / span) * 80;
  return (
    <div className="balance-now">
      <div className="balance-now-head">
        <strong>{`${b.name} right now`}</strong>
        <span className="balance-now-gap">
          {b.spread === null
            ? "Waiting for two readings"
            : `Gap ${fmtDelta(b.spread)} of ${fmtDelta(b.zone_gap)} allowed`}
        </span>
      </div>
      {b.zones.map((z) => (
        <div key={z.thermostat_entity_id} className="balance-zone">
          <span className="balance-zone-name">{z.name}</span>
          <span className="balance-track" aria-hidden="true">
            {z.temp !== null && (
              <span
                className={`balance-dot${z.target !== null ? ` balance-${b.direction ?? "heating"}` : ""}`}
                style={{ left: `${at(z.temp).toFixed(1)}%` }}
              />
            )}
          </span>
          <strong className="balance-zone-temp">
            {z.temp === null ? "No reading" : fmtTemp(z.temp)}
          </strong>
        </div>
      ))}
      <p className="rule-help">{describeBalance(b, fmtTemp, fmtDelta)}</p>
    </div>
  );
}

/** Smart Control → Zone Balance: keep a building's zones within a gap of each other. */
export default function ZoneBalanceSection() {
  const { unit, unitLabel, fmtTemp, toDisplayDelta } = useUnit();
  const [buildings, setBuildings] = useState<BalanceBuilding[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getZoneBalance()
        .then((d) => {
          // Not over a change being saved: its answer is the newer one.
          if (!cancelled && !saving.current) setBuildings(d.buildings);
        })
        .catch(() => {
          // A failed refresh keeps what is shown; only a failed first load says so.
          if (!cancelled) setLoadFailed(true);
        });
    void load();
    // The gap moves with the house: look again every half minute.
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const change = async (id: string, patch: { level?: BalanceLevel; zone_gap?: number }) => {
    setErr(null);
    setBusy(true);
    saving.current = true;
    try {
      setBuildings((await setZoneBalance(id, patch)).buildings);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const fmtDelta = (f: number) => `${toDisplayDelta(f).toFixed(1)}${unitLabel}`;

  return (
    <div className="card">
      <h3 className="card-title">Zone Balance</h3>
      <p className="sc-section-lead">
        Zones in one building share walls, stairs and doorways. When one runs far warmer or cooler
        than the others, they work against it.
      </p>
      {loadFailed && !buildings && <p className="form-error">Could not load the buildings.</p>}
      {!loadFailed && !buildings && <p className="page-subtitle">Loading the buildings…</p>}
      {buildings && buildings.length === 0 && (
        <p className="page-subtitle">Add a building in My Home and put zones in it to use this.</p>
      )}
      {buildings?.map((b) => {
        const shown = Number(toDisplayDelta(b.zone_gap).toFixed(1));
        const choices: number[] = [...GAP_CHOICES[unit]];
        if (!choices.includes(shown)) choices.push(shown);
        choices.sort((x, y) => x - y);
        return (
          <div key={b.building_id} className="balance-building" role="group" aria-label={b.name}>
            <div className="rule-row">
              <div className="rule-text">
                <span className="rule-title">{`Limit the Gap Between Zones in ${b.name} To`}</span>
                <p className="rule-help">{LEVEL_HELP[b.level]}</p>
              </div>
              <div className="rule-value balance-controls">
                <select
                  className="form-control"
                  aria-label={`Gap limit for ${b.name}`}
                  value={shown}
                  disabled={busy}
                  onChange={(e) => void change(b.building_id, { zone_gap: Number(e.target.value) })}
                >
                  {choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <span className="minutes-unit">{unitLabel}</span>
                <select
                  className="form-control"
                  aria-label={`Balance for ${b.name}`}
                  value={b.level}
                  disabled={busy}
                  onChange={(e) =>
                    void change(b.building_id, { level: e.target.value as BalanceLevel })
                  }
                >
                  {(Object.keys(BALANCE_LEVEL_LABELS) as BalanceLevel[]).map((l) => (
                    <option key={l} value={l}>
                      {BALANCE_LEVEL_LABELS[l]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Frozen>
              <BalanceNow building={b} fmtTemp={fmtTemp} fmtDelta={fmtDelta} />
            </Frozen>
          </div>
        );
      })}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}
