import { useState } from "react";
import { type Room } from "../api";
import {
  deleteShade,
  describeSun,
  FACING_DEGREES,
  FACINGS,
  saveShade,
  type Facing,
  type Shade,
  type Shades,
  type ShadeWrite,
} from "../shadesApi";
import EntityPicker from "./EntityPicker";

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
  /** Given outside a room, to say which room each shade is in. */
  rooms?: Room[];
  azimuth: number | null;
  onSave: (entityId: string, data: ShadeWrite) => void;
  onRemove: (entityId: string) => void;
}) {
  const room = rooms?.find((r) => r.id === shade.room_id);
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
  roomId,
  onAdd,
  onCancel,
}: {
  roomId: string;
  onAdd: (entityId: string, data: ShadeWrite) => void;
  onCancel: () => void;
}) {
  const [entity, setEntity] = useState("");
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
          disabled={!entity || !facing}
          onClick={() => onAdd(entity, { room_id: roomId, facing: facing as Facing })}
        >
          Add Shade
        </button>
      </div>
    </div>
  );
}

/**
 * My Home → a room → Shades: the room's shades, each with the direction its
 * window faces, and a form to add one. How shades react to the sun is tuned
 * in Smart Control; which shades a room has is hardware, so it lives here.
 */
export default function RoomShades({
  room,
  data,
  onData,
}: {
  room: Room;
  data: Shades;
  onData: (d: Shades) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const mine = data.shades.filter((sh) => sh.room_id === room.id);

  const save = async (entityId: string, body: ShadeWrite): Promise<boolean> => {
    setErr(null);
    try {
      onData(await saveShade(entityId, body));
      return true;
    } catch (e) {
      setErr(errorText(e, "Could not save the shade"));
      return false;
    }
  };
  const remove = async (entityId: string) => {
    setErr(null);
    try {
      onData(await deleteShade(entityId));
    } catch (e) {
      setErr(errorText(e, "Could not remove the shade"));
    }
  };

  return (
    <div className="room-shades">
      <div className="sc-section-head">
        <span className="sensor-zone-meta">{describeSun(data.sun)}</span>
        {!adding && (
          <button type="button" className="btn btn-secondary" onClick={() => setAdding(true)}>
            Add Shade
          </button>
        )}
      </div>
      {err && <p className="form-error">{err}</p>}
      {adding && (
        <AddShade
          roomId={room.id}
          onCancel={() => setAdding(false)}
          onAdd={async (id, body) => {
            if (await save(id, body)) setAdding(false);
          }}
        />
      )}
      {mine.length === 0 && !adding && (
        <p className="empty-panel">
          No shades in this room yet. Add each one with the direction its window faces.
        </p>
      )}
      {mine.length > 0 && (
        <div className="sensor-zone">
          {mine.map((sh) => (
            <ShadeRow
              key={sh.entity_id}
              shade={sh}
              azimuth={data.sun.azimuth}
              onSave={save}
              onRemove={remove}
            />
          ))}
        </div>
      )}
    </div>
  );
}
