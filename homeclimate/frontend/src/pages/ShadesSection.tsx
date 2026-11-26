import { useEffect, useState } from "react";
import { Link } from "react-router";
import { type Room } from "../api";
import EntityPicker from "../components/EntityPicker";
import { MinutesInput, RuleRow } from "../components/SmartControlControls";
import {
  describeSun,
  getShades,
  updateShadeSettings,
  type Shades,
  type ShadeSettings,
} from "../shadesApi";

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

export default function ShadesSection({ rooms }: { rooms: Room[] }) {
  const [data, setData] = useState<Shades | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getShades()
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

  if (loadFailed) {
    return <p className="form-error">Could not load shades.</p>;
  }
  if (!data) return <p className="page-subtitle">Loading shades…</p>;

  const s = data.settings;
  const set = async (patch: Partial<ShadeSettings>) => {
    setErr(null);
    try {
      setData(await updateShadeSettings(patch));
    } catch (e) {
      setErr(errorText(e, "Could not save the setting"));
    }
  };
  const toggle = (key: keyof ShadeSettings, title: string, help: string) => (
    <RuleRow
      id={`shades-${key}`}
      title={title}
      help={help}
      enabled={s[key] as boolean}
      onToggle={(v) => set({ [key]: v })}
    >
      {null}
    </RuleRow>
  );

  return (
    <>
      <section className="sc-section" id="shades">
        <h2 className="sc-section-title">Shades</h2>
        <p className="sc-section-lead">Let the sun in when heating and keep it out when cooling.</p>
        {toggle(
          "auto_enabled",
          "Automatically Control Shades to Optimize Solar Effects",
          "Opens sunlit shades when heating and closes them when cooling."
        )}
        {toggle(
          "skip_occupied",
          "Do Not Control Shades in an Occupied Room",
          "Uses the room's presence sensors."
        )}
        {toggle(
          "daylight_only",
          "Only Between Sunrise and Sunset",
          "Shades are left alone overnight."
        )}
        {toggle(
          "predictive_close",
          "Close Ahead of a Warm Room",
          "A sunlit shade also closes before any cooling runs, when it is warmer outside and the room is close to the top of what it is asked to hold, or is expected to pass it on a warming afternoon."
        )}
        {toggle(
          "close_night_heat",
          "Close at Night in Heat Mode",
          "A closed shade holds in a little more heat. Turn off Only Between Sunrise and Sunset for this to work."
        )}
        <RuleRow
          id="shades-respect_manual"
          title="Respect Manual Moves For"
          help="Moving a shade yourself pauses automation for that shade."
          enabled={s.respect_manual}
          onToggle={(v) => set({ respect_manual: v })}
        >
          <MinutesInput
            value={s.manual_hold_min}
            min={15}
            max={720}
            label="Manual move hold in minutes"
            disabled={!s.respect_manual}
            onCommit={(n) => set({ manual_hold_min: n })}
          />
        </RuleRow>
        <RuleRow
          id="shades-quiet_hours"
          title="Quiet Hours"
          help="Shades marked for quiet hours never move between these times, in the house's time zone."
          enabled={s.quiet_hours}
          onToggle={(v) => set({ quiet_hours: v })}
        >
          <span className="minutes-field">
            <input
              className="form-control"
              type="time"
              aria-label="Quiet hours start"
              value={s.quiet_start}
              disabled={!s.quiet_hours}
              onChange={(e) => e.target.value && set({ quiet_start: e.target.value })}
            />
            <span className="minutes-unit">to</span>
            <input
              className="form-control"
              type="time"
              aria-label="Quiet hours end"
              value={s.quiet_end}
              disabled={!s.quiet_hours}
              onChange={(e) => e.target.value && set({ quiet_end: e.target.value })}
            />
          </span>
        </RuleRow>
        <RuleRow
          id="shades-min_move"
          title="Minimum Time Between Moves"
          help="Keeps shades from moving back and forth as clouds pass."
        >
          <MinutesInput
            value={s.min_move_min}
            min={5}
            max={240}
            label="Minimum time between moves in minutes"
            onCommit={(n) => set({ min_move_min: n })}
          />
        </RuleRow>
        <div className="rule-row">
          <span className="switch-spacer" />
          <div className="rule-text">
            <span className="rule-title">Cloud Cover From</span>
            <p className="rule-help">Shades are left alone when the sky is 80% or more overcast.</p>
          </div>
          <div className="rule-value">
            {s.weather_entity ? (
              <div className="picked-entity">
                <span>{s.weather_entity}</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => set({ weather_entity: "" })}
                >
                  Clear
                </button>
              </div>
            ) : (
              <EntityPicker
                domain="weather"
                placeholder="Not set"
                onSelect={(id) => set({ weather_entity: id })}
              />
            )}
          </div>
        </div>
        {err && <p className="form-error">{err}</p>}
      </section>

      <section className="sc-section">
        <div className="sc-section-head">
          <h2 className="sc-section-title">Your Shades</h2>
          <span className="sensor-zone-meta">{describeSun(data.sun)}</span>
        </div>
        <p className="sc-section-lead">
          Shades are added, and their window direction set, from each room in{" "}
          <Link to="/my-home">My Home</Link>.
        </p>
        {data.shades.length === 0 ? (
          <p className="empty-panel">No shades yet.</p>
        ) : (
          <ul className="shade-status">
            {data.shades.map((sh) => (
              <li key={sh.entity_id}>
                <span className="sensor-title">{sh.name}</span>
                <span className="shade-why">
                  {`${rooms.find((r) => r.id === sh.room_id)?.name ?? "No room"}. ${sh.reason || "Waiting for the next check."}`}
                </span>
                <span className={`shade-state shade-${sh.state}`}>
                  {
                    { open: "Open", closed: "Closed", moving: "Moving", unknown: "Unknown" }[
                      sh.state
                    ]
                  }
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
