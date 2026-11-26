import { useEffect, useRef, useState } from "react";
import { Frozen } from "../ci";
import { FAN_LEVEL_LABELS, describeFan, getFan, type FanLevel, type FanZone } from "../fanApi";
import { updateZone } from "../zonesApi";

const REFRESH_MS = 30_000;

const LEVEL_HELP: Record<FanLevel, string> = {
  off: "The fan is left to the thermostat.",
  watch: "Logs when it would have run the fan, and does not touch it.",
  on: "Runs the fan alone to mix the zone's rooms, and hands it back to the thermostat afterwards.",
};

/** Smart Control → Fan: mix a zone's rooms while heating or cooling is held off. */
export default function FanSection() {
  const [zones, setZones] = useState<FanZone[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getFan()
        .then((d) => {
          // Not over a change being saved: its answer is the newer one.
          if (!cancelled && !saving.current) setZones(d.zones);
        })
        .catch(() => {
          // A failed refresh keeps what is shown; only a failed first load says so.
          if (!cancelled) setLoadFailed(true);
        });
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const change = async (id: string, fan_level: FanLevel) => {
    setErr(null);
    setBusy(true);
    saving.current = true;
    try {
      await updateZone(id, { fan_level });
      setZones((await getFan()).zones);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3 className="card-title">Fan</h3>
      <p className="page-subtitle">
        Runs the fan by itself to even out the rooms of a zone. Only while the zone is idle and its
        building is heating or cooling as one.
      </p>
      {loadFailed && !zones && <p className="form-error">Could not load the zones.</p>}
      {!loadFailed && !zones && <p className="page-subtitle">Loading the zones…</p>}
      {zones && zones.length === 0 && (
        <p className="page-subtitle">Add a zone with rooms in My Home to use this.</p>
      )}
      {zones?.map((z) => (
        <div key={z.thermostat_entity_id} className="calendar-row" role="group" aria-label={z.name}>
          <div className="calendar-room">
            <span className="sensor-title">{z.name}</span>
            <span className="shade-why">
              <Frozen>{describeFan(z)}</Frozen>
            </span>
            {z.level !== "off" && (
              <span className="form-hint">
                <Frozen>{`Ran ${z.minutes_last_hour} of the last 60 minutes.`}</Frozen>
              </span>
            )}
          </div>
          <label className="field-stack">
            Fan
            <select
              className="form-control"
              aria-label={`Fan for ${z.name}`}
              value={z.level}
              disabled={busy}
              onChange={(e) => void change(z.thermostat_entity_id, e.target.value as FanLevel)}
            >
              {(Object.keys(FAN_LEVEL_LABELS) as FanLevel[]).map((l) => (
                <option key={l} value={l}>
                  {FAN_LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
            <span className="form-hint">{LEVEL_HELP[z.level]}</span>
            {!z.supported && (
              <span className="form-hint">
                This thermostat does not offer an on and auto fan setting in Home Assistant, so
                HomeClimate cannot run its fan.
              </span>
            )}
          </label>
        </div>
      ))}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}
