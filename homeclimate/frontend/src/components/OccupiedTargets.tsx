import { useState } from "react";
import { updateRoom, type Room } from "../api";
import { targetPair } from "../bands";
import { useUnit } from "../contexts";

/**
 * Dashboard → a room → When Occupied: the Heating Target and Cooling Target
 * the room is kept between while someone is in it. The same number in both is
 * one temperature. Empty: occupancy does not change the room.
 *
 * Holds what was typed, in display units; the backend converts on the way in.
 */
export default function OccupiedTargets({
  room,
  onSaved,
}: {
  room: Room;
  onSaved: (saved: Room) => void;
}) {
  const { toDisplay, displayBound, unitLabel } = useUnit();
  const text = (f: number | null | undefined) => (f != null ? String(toDisplay(f)) : "");
  const stored = {
    heat: text(room.system_wide_temp),
    // One temperature reads as the same number in both.
    cool: text(room.presence_cool_to ?? room.system_wide_temp),
  };
  const [form, setForm] = useState(stored);
  // What the form is compared with: the room as handed in, or as last saved.
  const [base, setBase] = useState(stored);
  const [seen, setSeen] = useState(stored);
  if (seen.heat !== stored.heat || seen.cool !== stored.cool) {
    // The room handed in changed (a refetch, or the display unit). Show it,
    // unless it is only the page catching up with what was just saved here:
    // then anything typed since is kept.
    setSeen(stored);
    if (base.heat !== stored.heat || base.cool !== stored.cool) {
      setBase(stored);
      setForm(stored);
    }
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = form.heat !== base.heat || form.cool !== base.cool;

  const save = async () => {
    const pair = targetPair(form.heat, form.cool);
    if (pair === "need heat") {
      setError("Add a Heating Target too. The same number in both keeps one temperature.");
      return;
    }
    if (pair === "crossed") {
      setError("The Cooling Target cannot be below the Heating Target.");
      return;
    }
    // Rounded outward, so the limit shown is one the backend accepts.
    const lo = displayBound(40, "min");
    const hi = displayBound(90, "max");
    const out = (t: number | null) => t != null && (isNaN(t) || t < lo || t > hi);
    if (out(pair.target) || out(pair.coolTo)) {
      setError(
        `Use temperatures from ${lo.toFixed(1)}${unitLabel} to ${hi.toFixed(1)}${unitLabel}.`
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      const kept = await updateRoom(room.id, {
        system_wide_temp: pair.target,
        presence_cool_to: pair.coolTo,
      });
      // Show what was stored, even where it rounds to something else.
      const now = {
        heat: text(kept.system_wide_temp),
        cool: text(kept.presence_cool_to ?? kept.system_wide_temp),
      };
      setBase(now);
      setForm(now);
      onSaved(kept);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const field = (key: "heat" | "cool", label: string) => (
    <label className="field-stack">
      {`${label} (${unitLabel})`}
      <input
        className="form-control house-band-input"
        type="number"
        inputMode="decimal"
        step="any"
        aria-label={`${label} when ${room.name} is occupied (${unitLabel})`}
        value={form[key]}
        disabled={saving}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
    </label>
  );
  return (
    <div className="targets-row" role="group" aria-label={`${room.name} when occupied`}>
      <div className="house-band-fields">
        {field("heat", "Heating Target")}
        {field("cool", "Cooling Target")}
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
