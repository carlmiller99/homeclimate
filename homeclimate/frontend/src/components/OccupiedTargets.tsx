import { useState } from "react";
import { updateRoom, type Room } from "../api";
import { coolToValue } from "../bands";
import { useUnit } from "../contexts";

/**
 * Dashboard → a room → When Occupied: the temperature the room is kept at
 * while someone is in it, with an optional Cool To that makes it a range.
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
  const stored = { temp: text(room.system_wide_temp), coolTo: text(room.presence_cool_to) };
  const [form, setForm] = useState(stored);
  // What the form is compared with: the room as handed in, or as last saved.
  const [base, setBase] = useState(stored);
  const [seen, setSeen] = useState(stored);
  if (seen.temp !== stored.temp || seen.coolTo !== stored.coolTo) {
    // The room handed in changed (a refetch, or the display unit). Show it,
    // unless it is only the page catching up with what was just saved here:
    // then anything typed since is kept.
    setSeen(stored);
    if (base.temp !== stored.temp || base.coolTo !== stored.coolTo) {
      setBase(stored);
      setForm(stored);
    }
  }
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const dirty = form.temp !== base.temp || form.coolTo !== base.coolTo;

  const save = async () => {
    setSaved(false);
    const temp = form.temp.trim() === "" ? null : parseFloat(form.temp);
    // Rounded outward, so the limit shown is one the backend accepts.
    const lo = displayBound(40, "min");
    const hi = displayBound(90, "max");
    if (temp != null && (isNaN(temp) || temp < lo || temp > hi)) {
      setError(
        `Use a temperature from ${lo.toFixed(1)}${unitLabel} to ${hi.toFixed(1)}${unitLabel}.`
      );
      return;
    }
    if (form.coolTo.trim() !== "" && temp == null) {
      setError("Cool To needs a temperature to pair with.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const kept = await updateRoom(room.id, {
        system_wide_temp: temp,
        presence_cool_to: temp == null ? null : coolToValue(form.coolTo),
      });
      // Show what was stored, even where it rounds to something else.
      const now = { temp: text(kept.system_wide_temp), coolTo: text(kept.presence_cool_to) };
      setBase(now);
      setForm(now);
      setSaved(true);
      onSaved(kept);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const field = (key: "temp" | "coolTo", label: string, placeholder: string) => (
    <label className="occupied-field">
      <span>{`${label} (${unitLabel})`}</span>
      <input
        className="form-control"
        type="number"
        step="0.5"
        value={form[key]}
        placeholder={placeholder}
        disabled={saving}
        onChange={(e) => {
          setSaved(false);
          setForm((f) => ({ ...f, [key]: e.target.value }));
        }}
      />
    </label>
  );
  return (
    <section className="room-details-block" aria-label="When occupied">
      <h4 className="room-details-title">When Occupied</h4>
      <div className="occupied-fields">
        {field("temp", "Temperature", "Not set")}
        {field("coolTo", "Cool To", "One temperature")}
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && !dirty && (
          <span className="shade-why" role="status">
            Saved
          </span>
        )}
      </div>
      <p className="field-help">
        Kept here while someone is in the room and no schedule is running. Add a Cool To and the
        room is kept between the two.
      </p>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
