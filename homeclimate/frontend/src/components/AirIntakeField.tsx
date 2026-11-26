import { useEffect, useState } from "react";
import { useUnit } from "../contexts";
import Time from "./Time";
import {
  AIR_INTAKE_LABELS,
  describeTest,
  getFan,
  testFan,
  type AirIntake,
  type Fan,
  type FanZone,
} from "../fanApi";

const POLL_MS = 30_000;

/**
 * My Home → Edit Zone: whether the air handler draws in outside air, with a
 * test that runs the fan alone and reports a hint. The choice is part of the
 * zone's form and saved with it; the test runs straight away.
 */
export default function AirIntakeField({
  entityId,
  zoneName,
  value,
  onChange,
}: {
  entityId: string;
  zoneName: string;
  value: AirIntake;
  onChange: (value: AirIntake) => void;
}) {
  const { toDisplayDelta, unitLabel } = useUnit();
  const [zone, setZone] = useState<FanZone | null>(null);
  const [minutes, setMinutes] = useState(10);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const take = (fan: Fan) => {
    setMinutes(fan.test_minutes);
    setZone(fan.zones.find((z) => z.thermostat_entity_id === entityId) ?? null);
  };

  const testing = zone?.testing ?? false;
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getFan()
        .then((fan) => {
          if (!cancelled) take(fan);
        })
        // The setting works without it; only the test needs the zone's state.
        .catch(() => {});
    void load();
    // While a test runs, look again until it has finished.
    const timer = testing ? setInterval(() => void load(), POLL_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `take` only sets state
  }, [entityId, testing]);

  const start = async () => {
    setErr(null);
    setStarting(true);
    try {
      take(await testFan(entityId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the test");
    } finally {
      setStarting(false);
    }
  };

  const fmtDelta = (f: number) => `${toDisplayDelta(f)}${unitLabel}`;

  return (
    <div className="field-stack air-intake">
      <label className="field-stack">
        Outside Air Intake
        <select
          className="form-control"
          aria-label={`Outside air intake for ${zoneName}`}
          value={value}
          onChange={(e) => onChange(e.target.value as AirIntake)}
        >
          {(Object.keys(AIR_INTAKE_LABELS) as AirIntake[]).map((k) => (
            <option key={k} value={k}>
              {AIR_INTAKE_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <p className="field-help">
        Does this system have a duct that brings in outside air when its fan runs? With one,
        HomeClimate only runs the fan by itself while outside air would help. Not Sure is treated as
        No.
      </p>
      {zone && (
        <div className="air-intake-test">
          <button
            type="button"
            className="btn btn-secondary"
            aria-label={`Test ${zoneName} for an outside air intake`}
            disabled={starting || testing || !zone.supported}
            onClick={() => void start()}
          >
            {testing ? "Testing…" : "Test"}
          </button>
          <p className="field-help">
            {!zone.supported
              ? "This thermostat does not offer an on and auto fan setting in Home Assistant, so it cannot be tested."
              : testing
                ? `Running the fan alone for ${minutes} minutes. The result appears here.`
                : `Runs the fan alone for ${minutes} minutes and watches whether the rooms move toward the outside temperature. It gives a hint, not an answer: the hardware decides.`}
          </p>
          {!testing && (
            <p className="field-help" role="status">
              {describeTest(zone.test, fmtDelta)}
              {zone.test && (
                <>
                  {" "}
                  (<Time value={zone.test.at} />)
                </>
              )}
            </p>
          )}
        </div>
      )}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}
