import { useState } from "react";
import ConfirmDialog from "./ConfirmDialog";
import { useUnit } from "../contexts";
import { setTargets, targetsFor, type House, type TargetScope } from "../houseApi";

/** One level of the home that can carry targets, and what it inherits from. */
export interface TargetLevel {
  scope: TargetScope;
  id: string;
  name: string;
  /** The level above whose targets apply when this one has none. */
  parent?: TargetLevel;
}

/** °F: targets closer than this get a note about heating and cooling in turn. */
const CLOSE_F = 2;

/** The targets a level uses: its own, else the nearest level above that has some. */
function effective(house: House, level: TargetLevel | undefined) {
  for (let at = level; at; at = at.parent) {
    const own = targetsFor(house, at.scope, at.id);
    if (own) return { ...own, from: at };
  }
  return null;
}

/** What clearing a level's targets does when nothing above it has any. */
const CLEAR_WITH_NOTHING_ABOVE: Record<TargetScope, string> = {
  building:
    "Rooms in this building that have no targets of their own, or from their zone, stop asking for heating or cooling straight away, which ends any cycle running just for them.",
  zone: "Rooms in this zone that have no targets of their own stop asking for heating or cooling straight away, which ends any cycle running just for them.",
  room: "This room stops asking for heating or cooling straight away, unless a hold, a schedule or occupancy gives it a target. That ends any cycle running just for it.",
};

/**
 * One level's heating and cooling targets. Form values are display-unit text;
 * the backend converts on write (#231). Re-derived during render, keyed on the
 * stored content, so a refetch never discards what is being typed (pitfall 9).
 */
function TargetsRow({
  house,
  level,
  onSaved,
}: {
  house: House;
  level: TargetLevel;
  onSaved: (house: House) => void;
}) {
  const { toDisplay, toDisplayDelta, unitLabel } = useUnit();
  const own = targetsFor(house, level.scope, level.id);
  const inherited = effective(house, level.parent);
  const stored = {
    heat: own ? String(toDisplay(own.heat)) : "",
    cool: own ? String(toDisplay(own.cool)) : "",
  };
  const [form, setForm] = useState(stored);
  const [derived, setDerived] = useState(stored);
  if (derived.heat !== stored.heat || derived.cool !== stored.cool) {
    setDerived(stored);
    setForm(stored);
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const heat = form.heat.trim() === "" ? NaN : Number(form.heat);
  const cool = form.cool.trim() === "" ? NaN : Number(form.cool);
  const valid = Number.isFinite(heat) && Number.isFinite(cool) && cool >= heat;
  const dirty = form.heat !== stored.heat || form.cool !== stored.cool;

  const send = async (h: number | null, c: number | null) => {
    setError(null);
    setSaving(true);
    try {
      const saved = await setTargets(level.scope, level.id, h, c);
      // Show what was stored, even when it reads the same as before ("71.0" → "71").
      const now = targetsFor(saved, level.scope, level.id);
      const next = {
        heat: now ? String(toDisplay(now.heat)) : "",
        cool: now ? String(toDisplay(now.cool)) : "",
      };
      setDerived(next);
      setForm(next);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the targets");
    } finally {
      setSaving(false);
    }
  };

  const follows = inherited
    ? `Follows ${inherited.from.name}: ${toDisplay(inherited.heat)} to ${toDisplay(inherited.cool)}${unitLabel}`
    : level.parent
      ? `No targets set, here or for ${level.parent.name}`
      : "No targets set";

  return (
    <div className={`targets-row targets-row-${level.scope}`} role="group" aria-label={level.name}>
      <div className="targets-row-name">
        <span className="targets-name">{level.name}</span>
        {!own && <span className="targets-follows">{follows}</span>}
      </div>
      <div className="house-band-fields">
        <label className="field-stack">
          {`Heating Target (${unitLabel})`}
          <input
            className="form-control house-band-input"
            type="number"
            inputMode="decimal"
            step="any"
            aria-label={`Heating Target for ${level.name} (${unitLabel})`}
            placeholder={inherited ? String(toDisplay(inherited.heat)) : ""}
            value={form.heat}
            disabled={saving}
            onChange={(e) => setForm({ ...form, heat: e.target.value })}
          />
        </label>
        <label className="field-stack">
          {`Cooling Target (${unitLabel})`}
          <input
            className="form-control house-band-input"
            type="number"
            inputMode="decimal"
            step="any"
            aria-label={`Cooling Target for ${level.name} (${unitLabel})`}
            placeholder={inherited ? String(toDisplay(inherited.cool)) : ""}
            value={form.cool}
            disabled={saving}
            onChange={(e) => setForm({ ...form, cool: e.target.value })}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          aria-label={`Save targets for ${level.name}`}
          disabled={saving || !valid || !dirty}
          onClick={() => void send(heat, cool)}
        >
          Save
        </button>
        {own && (
          <button
            type="button"
            className="btn btn-secondary"
            aria-label={`Clear targets for ${level.name}`}
            disabled={saving}
            onClick={() => setConfirmClear(true)}
          >
            Clear
          </button>
        )}
      </div>
      {Number.isFinite(heat) && Number.isFinite(cool) && cool < heat && (
        <p className="form-error">The cooling target cannot be below the heating target.</p>
      )}
      {valid && cool - heat < toDisplayDelta(CLOSE_F) && (
        <p className="targets-follows targets-note">
          With targets this close, only a room&apos;s deadband separates heating from cooling. To
          limit how often the building changes between them, turn its Auto on under Smart Control.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      {confirmClear && (
        <ConfirmDialog
          title="Clear these targets?"
          message={
            inherited
              ? `This ${level.scope} goes back to following ${inherited.from.name}.`
              : CLEAR_WITH_NOTHING_ABOVE[level.scope]
          }
          confirmLabel="Clear Targets"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void send(null, null);
          }}
        />
      )}
    </div>
  );
}

/** A building (or a zone in no building) with the zones and rooms under it. */
export interface TargetGroup {
  top: TargetLevel;
  /** Zones under a building, each with its rooms; or just rooms under a zone. */
  children: { level: TargetLevel; rooms: TargetLevel[] }[];
}

/**
 * Dashboard → Targets: a heating and a cooling target for each building, with
 * its zones and rooms folded underneath for the ones that should differ.
 */
export default function TargetsCard({
  house,
  groups,
  onSaved,
}: {
  house: House;
  groups: TargetGroup[];
  onSaved: (house: House) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <section className="house-band targets-card" aria-labelledby="targets-title">
      <div className="house-band-text">
        <h2 className="house-band-title" id="targets-title">
          Targets
        </h2>
        <p className="house-band-help">
          A heating target and a cooling target; they can be the same number. A room is heated below
          the first and cooled above the second, unless a hold, a schedule or occupancy gives it its
          own. A room follows its zone, and a zone its building, unless you give it targets of its
          own.
        </p>
      </div>
      {groups.map((g) => (
        <div key={`${g.top.scope}:${g.top.id}`} className="targets-group">
          <TargetsRow house={house} level={g.top} onSaved={onSaved} />
          {g.children.length > 0 && (
            <details className="targets-more">
              <summary>
                {g.top.scope === "building"
                  ? `Zones and rooms in ${g.top.name}`
                  : `Rooms in ${g.top.name}`}
              </summary>
              {g.children.map((c) => (
                <div key={`${c.level.scope}:${c.level.id}`}>
                  <TargetsRow house={house} level={c.level} onSaved={onSaved} />
                  {c.rooms.map((r) => (
                    <TargetsRow key={r.id} house={house} level={r} onSaved={onSaved} />
                  ))}
                </div>
              ))}
            </details>
          )}
        </div>
      ))}
    </section>
  );
}
