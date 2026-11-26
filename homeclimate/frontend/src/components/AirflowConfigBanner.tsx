import { useEffect, useState } from "react";
import { getThermostats, type ThermostatConfig } from "../api";
import Notice from "./Notice";

/**
 * Surfaces thermostats that still need the airflow-floor fields filled in
 * after upgrading to #213.
 *
 * Pre-#213 the engine used a flat ``min_open_vents`` count.  When the new
 * fields ship, existing thermostats end up with ``total_vents_count = null``
 * and the engine falls back to the prior "≥1 open" default — safe but not
 * the proper fraction-based floor.  This banner is what asks the user to
 * finish configuring so the new safety actually applies.
 *
 * Renders nothing when every thermostat has either ``total_vents_count`` set
 * OR ``has_bypass_damper`` ticked (the two valid configurations).  Polled on
 * mount; the banner disappears automatically once the user updates a card.
 */
export default function AirflowConfigBanner() {
  const [unconfigured, setUnconfigured] = useState<ThermostatConfig[]>([]);

  useEffect(() => {
    let cancelled = false;
    getThermostats()
      .then((tcs) => {
        if (cancelled) return;
        setUnconfigured(tcs.filter((tc) => tc.total_vents_count === null && !tc.has_bypass_damper));
      })
      .catch(() => {
        /* a network blip on load is not worth nagging about — try again
           the next time the page mounts */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (unconfigured.length === 0) return null;

  const n = unconfigured.length;
  const names = unconfigured.map((tc) => tc.name || tc.thermostat_entity_id);
  return (
    <Notice
      title={`${n} zone${n === 1 ? " needs" : "s need"} a vent count`}
      details={
        <>
          <ul>
            {names.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p>
            Closing too many vents at once can damage the equipment. With a vent count, HomeClimate
            always keeps enough of them open.
          </p>
        </>
      }
      to="/my-home"
      action="Set Up in My Home"
      testId="airflow-config-banner"
    >
      {`Until it is set, ${n === 1 ? names[0] : "each"} keeps one vent open and nothing more. Enter the total vent count, or mark a bypass damper, under Edit Zone.`}
    </Notice>
  );
}
