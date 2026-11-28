import EntityName from "../components/EntityName";
import { entityName } from "../entityNames";
import { useEffect, useState } from "react";
import { getRooms, type Room } from "../api";
import { Frozen } from "../ci";
import ConfirmDialog from "../components/ConfirmDialog";
import EntityPicker from "../components/EntityPicker";
import { MinutesInput, Switch } from "../components/SmartControlControls";
import Time from "../components/Time";
import {
  addFireplace,
  COOLDOWN_MAX_MIN,
  deleteFireplace,
  getFireplaces,
  saveFireplace,
  SIGNAL_DOMAINS,
  STATE_LABELS,
  type Fireplace,
  type FireplaceControl,
  type Fireplaces,
  type FireplaceWrite,
} from "../fireplaceApi";

const CONTROL_HELP: Record<FireplaceControl, string> = {
  off: "This fireplace is ignored. Its rooms are heated and cooled as usual.",
  on: "While it is lit or cooling down, the rooms it warms stop calling for heating or cooling, and are never cooled for being too warm.",
};

function RoomChecks({
  rooms,
  picked,
  legend,
  disabled,
  keepOne,
  onChange,
}: {
  rooms: Room[];
  picked: string[];
  legend: string;
  disabled?: boolean;
  /** A saved fireplace always warms a room, so its only ticked room can't be unticked. */
  keepOne?: boolean;
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="fireplace-rooms">
      <legend className="field-label">{legend}</legend>
      {rooms.map((r) => (
        <label key={r.id} className="field-inline">
          <input
            type="checkbox"
            checked={picked.includes(r.id)}
            disabled={disabled || (keepOne && picked.length === 1 && picked[0] === r.id)}
            title={
              keepOne && picked.length === 1 && picked[0] === r.id
                ? "A fireplace warms at least one room"
                : undefined
            }
            onChange={(e) =>
              onChange(e.target.checked ? [...picked, r.id] : picked.filter((id) => id !== r.id))
            }
          />
          {r.name}
        </label>
      ))}
    </fieldset>
  );
}

function FireplaceCard({
  fireplace: f,
  rooms,
  busy,
  attempt,
  onSave,
  onRemove,
}: {
  fireplace: Fireplace;
  rooms: Room[];
  busy: boolean;
  /** Bumped when a save is refused: drafts go back to what is stored. */
  attempt: number;
  onSave: (id: string, data: FireplaceWrite) => void;
  onRemove: (f: Fireplace) => void;
}) {
  const [name, setName] = useState(f.name);
  const [shown, setShown] = useState({ name: f.name, attempt });
  if (shown.name !== f.name || shown.attempt !== attempt) {
    // The stored name changed, or a save was refused: show what is stored
    // (adjust during render, keyed on content).
    setShown({ name: f.name, attempt });
    setName(f.name);
  }
  const ignored = f.control === "off";
  return (
    <div className="fireplace-card" role="group" aria-label={f.name}>
      <div className="fireplace-head">
        <div>
          <div className="sensor-title">{f.name}</div>
          <EntityName id={f.entity_id} className="shade-why" />
        </div>
        <span className={`fireplace-state fireplace-${ignored ? "out" : f.state}`} role="status">
          {ignored ? "Ignored" : f.signal_lost ? "Signal Lost While Lit" : STATE_LABELS[f.state]}
          <Frozen frozen={null}>
            {!ignored && f.state === "lit" && f.lit_since && (
              <>
                {" since "}
                <Time
                  value={f.lit_since}
                  kind="time"
                  options={{ hour: "numeric", minute: "2-digit" }}
                />
              </>
            )}
            {!ignored && f.state === "cooling" && f.cooling_until && (
              <>
                {f.signal_lost ? ", held until " : " until "}
                <Time
                  value={f.cooling_until}
                  kind="time"
                  options={{ hour: "numeric", minute: "2-digit" }}
                />
              </>
            )}
          </Frozen>
        </span>
      </div>
      {f.setting_aside && (
        <p className="fireplace-note">
          The rooms it warms are not calling for heating or cooling right now.
        </p>
      )}
      {!ignored && f.signal_lost && (
        <p className="fireplace-note">
          {`${entityName(f.entity_id)} stopped reporting while the fire was lit, so HomeClimate is treating it as still lit.`}
        </p>
      )}
      {!ignored && f.state === "unknown" && (
        <p className="fireplace-note">
          {`${entityName(f.entity_id)} is not reporting, so HomeClimate can't tell whether the fire is lit.`}
        </p>
      )}
      <div className="fireplace-fields">
        <div className="field-stack">
          <span className="field-label">Fireplace Compensation</span>
          <Switch
            id={`fp-control-${f.id}`}
            checked={f.control === "on"}
            label={`Fireplace Compensation for ${f.name}`}
            disabled={busy}
            onChange={(on) => onSave(f.id, { control: on ? "on" : "off" })}
          />
        </div>
        <div className="field-stack">
          <span className="field-label">Cool-Down After It Goes Out</span>
          <MinutesInput
            key={attempt}
            value={f.cooldown_min}
            min={0}
            max={COOLDOWN_MAX_MIN}
            label={`Cool-down for ${f.name} in minutes`}
            disabled={busy}
            onCommit={(n) => onSave(f.id, { cooldown_min: n })}
          />
        </div>
      </div>
      <p className="rule-help" id={`fp-help-${f.id}`}>
        {CONTROL_HELP[f.control]}
      </p>
      <RoomChecks
        rooms={rooms}
        picked={f.room_ids}
        legend="Rooms It Warms"
        disabled={busy}
        keepOne
        onChange={(ids) => onSave(f.id, { room_ids: ids })}
      />
      <details className="shade-more">
        <summary>Name and Signal</summary>
        <div className="fireplace-fields">
          <label className="field-stack">
            Name
            <input
              className="form-control"
              value={name}
              maxLength={60}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                const next = name.trim();
                if (next && next !== f.name) onSave(f.id, { name: next });
                else setName(f.name);
              }}
            />
          </label>
          <div className="field-stack">
            <span className="field-label">On While the Fire Is Lit</span>
            <div className="picked-entity">
              <EntityName id={f.entity_id} />
            </div>
            <EntityPicker
              domain={SIGNAL_DOMAINS}
              placeholder="Change to…"
              onSelect={(id) => {
                if (id !== f.entity_id) onSave(f.id, { entity_id: id });
              }}
            />
          </div>
        </div>
      </details>
      <button
        type="button"
        className="link-button"
        aria-label={`Remove ${f.name}`}
        disabled={busy}
        onClick={() => onRemove(f)}
      >
        Remove
      </button>
    </div>
  );
}

function AddFireplace({
  rooms,
  busy,
  onAdd,
  onCancel,
}: {
  rooms: Room[];
  busy: boolean;
  onAdd: (data: FireplaceWrite) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [entity, setEntity] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div className="add-sensor" role="group" aria-label="Add Fireplace">
      <div className="add-sensor-fields">
        <label className="field-stack">
          Name
          <input
            className="form-control"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="field-stack">
          <span className="field-label">On While the Fire Is Lit</span>
          {entity ? (
            <div className="picked-entity">
              <span>{entity}</span>
              <button type="button" className="link-button" onClick={() => setEntity("")}>
                Change
              </button>
            </div>
          ) : (
            <EntityPicker
              domain={SIGNAL_DOMAINS}
              placeholder="Search switches, sensors…"
              onSelect={setEntity}
            />
          )}
        </div>
      </div>
      <RoomChecks rooms={rooms} picked={picked} legend="Rooms It Warms" onChange={setPicked} />
      <p className="rule-help">
        Include every room the fire heats, such as a room above it. A new fireplace starts on Watch
        Only.
      </p>
      <div className="add-sensor-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !name.trim() || !entity || picked.length === 0}
          onClick={() => onAdd({ name: name.trim(), entity_id: entity, room_ids: picked })}
        >
          Add Fireplace
        </button>
      </div>
    </div>
  );
}

export default function FireplaceSection() {
  const [data, setData] = useState<Fireplaces | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Fireplace | null>(null);
  // Bumped when a save is refused, so each card goes back to showing what is stored.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getFireplaces(), getRooms()])
      .then(([f, r]) => {
        if (cancelled) return;
        setData(f);
        setRooms([...r].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadFailed) return <p className="form-error">Could not load fireplaces.</p>;
  if (!data) return <p className="page-subtitle">Loading fireplaces…</p>;

  const run = async (call: () => Promise<Fireplaces>, fallback: string): Promise<boolean> => {
    if (busy) return false;
    setErr(null);
    setBusy(true);
    try {
      setData(await call());
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : fallback);
      setAttempt((n) => n + 1);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sc-section" id="fireplace">
      <div className="sc-section-head">
        <h2 className="sc-section-title">Fireplace</h2>
        {!adding && (
          <button type="button" className="btn btn-secondary" onClick={() => setAdding(true)}>
            Add Fireplace
          </button>
        )}
      </div>
      <p className="sc-section-lead">
        Tell HomeClimate when a fire is lit and which rooms it warms, so the heating and cooling
        don't work against it. HomeClimate never turns a fireplace on or off.
      </p>
      {err && <p className="form-error">{err}</p>}
      {adding && (
        <AddFireplace
          rooms={rooms}
          busy={busy}
          onCancel={() => setAdding(false)}
          onAdd={async (body) => {
            if (await run(() => addFireplace(body), "Could not add the fireplace"))
              setAdding(false);
          }}
        />
      )}
      {data.fireplaces.length === 0 && !adding && (
        <p className="page-subtitle">No fireplaces yet.</p>
      )}
      {data.fireplaces.map((f) => (
        <FireplaceCard
          key={f.id}
          fireplace={f}
          attempt={attempt}
          rooms={rooms}
          busy={busy}
          onSave={(id, body) =>
            void run(() => saveFireplace(id, body), "Could not save the fireplace")
          }
          onRemove={setRemoving}
        />
      ))}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message="Its rooms go back to normal control straight away."
          confirmLabel="Remove Fireplace"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const id = removing.id;
            setRemoving(null);
            void run(() => deleteFireplace(id), "Could not remove the fireplace");
          }}
        />
      )}
    </section>
  );
}
