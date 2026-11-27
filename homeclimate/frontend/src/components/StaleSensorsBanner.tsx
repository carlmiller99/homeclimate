import EntityName from "./EntityName";
import { useEffect, useState } from "react";
import { getSensorHealth, type SensorHealth } from "../api";
import { Frozen } from "../ci";
import Notice from "./Notice";

/**
 * Surfaces sensor-staleness on the Dashboard (Issue #211).
 *
 * Polls ``/api/sensor-health`` every 30 s. Renders nothing when every
 * configured room sensor is fresh; otherwise a notice naming the rooms, with
 * the sensors folded under Details.
 */
export default function StaleSensorsBanner() {
  const [health, setHealth] = useState<SensorHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      getSensorHealth()
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

  if (!health || health.rooms.length === 0) return null;

  const total = health.rooms.reduce((n, r) => n + r.stale_sensors.length, 0);

  const names = health.rooms.map((r) => r.room_name);
  return (
    <Notice
      title={`${total} sensor${total === 1 ? "" : "s"} not reporting`}
      details={
        <ul>
          {health.rooms.map((room) => (
            <li key={room.room_id}>
              <strong>{room.room_name}</strong>{" "}
              {room.stale_sensors.map((s, i) => (
                <span key={s.entity_id}>
                  {i > 0 && ", "}
                  <EntityName id={s.entity_id} />{" "}
                  <span className="text-muted">
                    (<Frozen>{formatAge(s)}</Frozen>)
                  </span>
                </span>
              ))}
            </li>
          ))}
        </ul>
      }
      to="/settings?section=sensors"
      action="Sensor Settings"
      testId="stale-sensors-banner"
    >
      {`${names.join(", ")}: a sensor silent for ${Math.round(health.stale_after_min)} min is left out of its room's average. Check its battery or connection.`}
    </Notice>
  );
}

function formatAge(s: { age_seconds: number | null; reason: string }): string {
  if (s.reason === "not_in_cache" || s.age_seconds === null) return "never seen by HA";
  const minutes = Math.round(s.age_seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
