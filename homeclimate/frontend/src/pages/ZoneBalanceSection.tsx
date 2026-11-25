import { useEffect, useState } from "react";
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
  off: "Zones are left to drift apart.",
  watch: "Logs what it would heat or cool, and does nothing.",
  on: "A zone too far behind one that is in use is brought back to the limit.",
};

/** Smart Control → Zone Balance: keep a building's zones within a gap of each other. */
export default function ZoneBalanceSection() {
  const { unit, unitLabel, fmtTemp, toDisplayDelta } = useUnit();
  const [buildings, setBuildings] = useState<BalanceBuilding[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getZoneBalance()
        .then((d) => {
          if (!cancelled) setBuildings(d.buildings);
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
    try {
      setBuildings((await setZoneBalance(id, patch)).buildings);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const fmtDelta = (f: number) => `${toDisplayDelta(f).toFixed(1)}${unitLabel}`;

  return (
    <div className="card">
      <h3 className="card-title">Zone Balance</h3>
      <p className="page-subtitle">
        When one zone of a building is in use and another has drifted, the gap between them grows
        until one is heating or cooling the other through the walls. With this on, a zone further
        behind than the limit is brought back to it: the least that keeps it within the limit, only
        in the direction the building is already working, and only while another zone is in use.
        Rooms with a hold, a schedule or occupancy are left alone, and so are paused zones.
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
          <div key={b.building_id} className="calendar-row" role="group" aria-label={b.name}>
            <div className="calendar-room">
              <span className="sensor-title">{b.name}</span>
              <span className="shade-why">
                <Frozen>{describeBalance(b, fmtTemp, fmtDelta)}</Frozen>
              </span>
              <span className="form-hint">
                <Frozen>
                  {b.zones
                    .map((z) => `${z.name} ${z.temp === null ? "no reading" : fmtTemp(z.temp)}`)
                    .join(" · ")}
                </Frozen>
              </span>
            </div>
            <label className="field-stack">
              Balance
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
              <span className="form-hint">{LEVEL_HELP[b.level]}</span>
            </label>
            <label className="field-stack">
              Gap Limit ({unitLabel})
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
              <span className="form-hint">How far apart zones may be.</span>
            </label>
          </div>
        );
      })}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}
