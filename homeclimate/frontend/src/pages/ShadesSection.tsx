import { useEffect, useState } from "react";
import { type Room } from "../api";
import EntityPicker from "../components/EntityPicker";
import { MinutesInput, RuleRow } from "../components/SmartControlControls";
import {
  deleteShade,
  describeSun,
  FACING_DEGREES,
  FACINGS,
  getShades,
  saveShade,
  updateShadeSettings,
  type Facing,
  type Shade,
  type Shades,
  type ShadeSettings,
  type ShadeWrite,
} from "../shadesApi";

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** A small compass: the window's direction and where the sun is. */
function Dial({ facing, azimuth, name }: { facing: Facing; azimuth: number | null; name: string }) {
  const label =
    azimuth === null
      ? `${name} faces ${facing}`
      : `${name} faces ${facing}, sun at ${Math.round(azimuth)}°`;
  return (
    <svg
      className="shade-dial"
      width="52"
      height="52"
      viewBox="0 0 52 52"
      role="img"
      aria-label={label}
    >
      <circle cx="26" cy="26" r="23" className="shade-dial-face" />
      {azimuth !== null && (
        <g transform={`rotate(${azimuth} 26 26)`}>
          <circle cx="26" cy="7" r="5" className="shade-dial-sun" />
        </g>
      )}
      <g transform={`rotate(${FACING_DEGREES[facing]} 26 26)`}>
        <path d="M26 26 L26 9" className="shade-dial-window" />
        <path d="M19 12h14" className="shade-dial-window" />
      </g>
    </svg>
  );
}

function PositionInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number | null;
  onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value === null ? "" : String(value));
  }
  const commit = () => {
    if (draft.trim() === "") {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      setDraft(value === null ? "" : String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <span className="field-inline">
      <label className="field-inline">
        {label}
        <input
          className="form-control minutes-input"
          type="number"
          min={0}
          max={100}
          placeholder="Full"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      </label>
      <span className="minutes-unit">%</span>
    </span>
  );
}

function ShadeRow({
  shade,
  rooms,
  azimuth,
  onSave,
  onRemove,
}: {
  shade: Shade;
  rooms: Room[];
  azimuth: number | null;
  onSave: (entityId: string, data: ShadeWrite) => void;
  onRemove: (entityId: string) => void;
}) {
  const room = rooms.find((r) => r.id === shade.room_id);
  return (
    <div className="shade-row">
      <Dial facing={shade.facing} azimuth={azimuth} name={shade.name} />
      <div className="shade-name">
        <div className="sensor-title">{shade.name}</div>
        <div className="shade-why">
          {room ? `${room.name}. ` : ""}
          {shade.reason || "Waiting for the next check."}
        </div>
      </div>
      <label className="sensor-scope">
        Window Faces
        <select
          className="form-control"
          value={shade.facing}
          aria-label={`Which way ${shade.name}'s window faces`}
          onChange={(e) => onSave(shade.entity_id, { facing: e.target.value as Facing })}
        >
          {FACINGS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <span className={`shade-state shade-${shade.state}`}>
        {{ open: "Open", closed: "Closed", moving: "Moving", unknown: "Unknown" }[shade.state]}
      </span>
      <details className="shade-more">
        <summary>Options</summary>
        <div className="shade-options">
          <label className="field-inline">
            <input
              type="checkbox"
              checked={shade.quiet_hours}
              onChange={(e) => onSave(shade.entity_id, { quiet_hours: e.target.checked })}
            />
            Quiet Hours Apply
          </label>
          <label className="field-inline">
            <input
              type="checkbox"
              checked={shade.never_control}
              onChange={(e) => onSave(shade.entity_id, { never_control: e.target.checked })}
            />
            Never Control This Shade
          </label>
          <PositionInput
            label="Open Position"
            value={shade.open_position}
            onCommit={(v) => onSave(shade.entity_id, { open_position: v })}
          />
          <PositionInput
            label="Closed Position"
            value={shade.closed_position}
            onCommit={(v) => onSave(shade.entity_id, { closed_position: v })}
          />
          <button
            type="button"
            className="link-button"
            aria-label={`Remove ${shade.name}`}
            onClick={() => onRemove(shade.entity_id)}
          >
            Remove
          </button>
        </div>
      </details>
    </div>
  );
}

function AddShade({
  rooms,
  onAdd,
  onCancel,
}: {
  rooms: Room[];
  onAdd: (entityId: string, data: ShadeWrite) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [entity, setEntity] = useState("");
  const [room, setRoom] = useState("");
  const [facing, setFacing] = useState("");
  return (
    <div className="add-sensor" role="group" aria-label="Add Shade">
      <div className="add-sensor-fields">
        <div className="field-stack">
          <span className="field-label">Shade</span>
          {entity ? (
            <div className="picked-entity">
              <span>{entity}</span>
              <button type="button" className="link-button" onClick={() => setEntity("")}>
                Change
              </button>
            </div>
          ) : (
            <EntityPicker domain="cover" placeholder="Search shades…" onSelect={setEntity} />
          )}
        </div>
        <label className="field-stack">
          Room
          <select className="form-control" value={room} onChange={(e) => setRoom(e.target.value)}>
            <option value="">Choose a room</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field-stack">
          Window Faces
          <select
            className="form-control"
            value={facing}
            onChange={(e) => setFacing(e.target.value)}
          >
            <option value="">Choose a direction</option>
            {FACINGS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="add-sensor-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!entity || !room || !facing}
          onClick={() => onAdd(entity, { room_id: room, facing: facing as Facing })}
        >
          Add Shade
        </button>
      </div>
    </div>
  );
}

export default function ShadesSection({ rooms }: { rooms: Room[] }) {
  const [data, setData] = useState<Shades | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [shadeErr, setShadeErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
  const save = async (entityId: string, body: ShadeWrite): Promise<boolean> => {
    setShadeErr(null);
    try {
      setData(await saveShade(entityId, body));
      return true;
    } catch (e) {
      setShadeErr(errorText(e, "Could not save the shade"));
      return false;
    }
  };
  const remove = async (entityId: string) => {
    setShadeErr(null);
    try {
      setData(await deleteShade(entityId));
    } catch (e) {
      setShadeErr(errorText(e, "Could not remove the shade"));
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
          {!adding && (
            <button type="button" className="btn btn-secondary" onClick={() => setAdding(true)}>
              Add Shade
            </button>
          )}
        </div>
        {shadeErr && <p className="form-error">{shadeErr}</p>}
        {adding && (
          <AddShade
            rooms={rooms}
            onCancel={() => setAdding(false)}
            onAdd={async (id, body) => {
              if (await save(id, body)) setAdding(false);
              return true;
            }}
          />
        )}
        {data.shades.length === 0 && !adding && (
          <p className="empty-panel">
            No shades yet. Add each one with the direction its window faces.
          </p>
        )}
        {data.shades.length > 0 && (
          <div className="sensor-zone">
            {data.shades.map((sh) => (
              <ShadeRow
                key={sh.entity_id}
                shade={sh}
                rooms={rooms}
                azimuth={data.sun.azimuth}
                onSave={save}
                onRemove={remove}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
