import { useEffect, useState } from "react";
import Notice from "./Notice";
import { getThermostatHealth, type ThermostatHealth, type UnavailableThermostat } from "../api";

/**
 * Surfaces thermostat unavailability on the Dashboard (Issue #267),
 * mirroring the stale-sensors banner.
 *
 * Polls ``/api/thermostat-health`` every 30 s. Renders nothing while every
 * registered thermostat is reachable. While one is unavailable the engine
 * cannot supervise its zone at all (no cycle timeout, no closed-vent
 * watchdog), so this is the one notice marked serious.
 */
export default function UnavailableThermostatsBanner() {
  const [health, setHealth] = useState<ThermostatHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      getThermostatHealth()
        .then((h) => {
          if (!cancelled) setHealth(h);
        })
        .catch(() => {
          /* network blip — leave previous state in place */
        });
    };
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!health || health.thermostats.length === 0) return null;

  const n = health.thermostats.length;

  return (
    <Notice
      serious
      title={`${n} thermostat${n === 1 ? "" : "s"} unavailable in Home Assistant`}
      details={
        <ul>
          {health.thermostats.map((t) => (
            <li key={t.thermostat_entity_id}>
              <strong>{t.name || t.thermostat_entity_id}</strong>{" "}
              <code>{t.thermostat_entity_id}</code>{" "}
              <span className="text-muted">({describe(t)})</span>
            </li>
          ))}
        </ul>
      }
      testId="unavailable-thermostats-banner"
    >
      {`${health.thermostats.map((t) => t.name || t.thermostat_entity_id).join(", ")}: ${n === 1 ? "its zone is" : "their zones are"} not being controlled until ${n === 1 ? "it is" : "they are"} back. Check the thermostat's power and connection, or the integration that provides it.`}
    </Notice>
  );
}

function describe(t: UnavailableThermostat): string {
  const age =
    t.reason === "not_in_cache" || t.unavailable_seconds === null
      ? "never seen by HA"
      : `unavailable ${formatAge(t.unavailable_seconds)}`;
  if (!t.cycle_running) return age;
  if (t.abort_after_min <= 0) {
    return `${age} — a cycle is running and will NOT be auto-aborted (abort disabled in the zone's Thermostat Settings)`;
  }
  return `${age} — the running cycle aborts after ${t.abort_after_min} min and all vents re-open`;
}

function formatAge(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "for under a minute";
  if (minutes < 60) return `for ${minutes} min`;
  return `for ${(minutes / 60).toFixed(1)} h`;
}
