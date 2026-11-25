import { useState } from "react";
import ConfirmDialog from "./ConfirmDialog";
import { useUnit } from "../contexts";
import { setHouseBand, type House } from "../houseApi";

/** The stored band as the two numbers the form shows, in the display unit. */
function shownBand(house: House, toDisplay: (f: number) => number) {
  return {
    heat: house.house_heat_to === null ? "" : String(toDisplay(house.house_heat_to)),
    cool: house.house_cool_to === null ? "" : String(toDisplay(house.house_cool_to)),
  };
}

/**
 * The whole-house band: heat rooms below one temperature, cool them above
 * another. Dashboard only renders this once the house has loaded, so the
 * inputs never show a value the server did not send.
 */
export default function HouseBandCard({
  house,
  onSaved,
}: {
  house: House;
  onSaved: (house: House) => void;
}) {
  const { toDisplay, toDisplayDelta, unitLabel } = useUnit();
  const stored = shownBand(house, toDisplay);
  const [form, setForm] = useState(stored);
  const [derived, setDerived] = useState(stored);
  if (derived.heat !== stored.heat || derived.cool !== stored.cool) {
    // The stored band changed (a save, or a refetch with new values): show it.
    // Keyed on content, adjusted during render.
    setDerived(stored);
    setForm(stored);
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  const isSet = house.house_heat_to !== null;
  const heat = form.heat.trim() === "" ? NaN : Number(form.heat);
  const cool = form.cool.trim() === "" ? NaN : Number(form.cool);
  const gap = toDisplayDelta(house.min_gap);
  const valid = Number.isFinite(heat) && Number.isFinite(cool);
  const dirty = form.heat !== stored.heat || form.cool !== stored.cool;

  const send = async (h: number | null, c: number | null) => {
    setError(null);
    setSaving(true);
    try {
      const saved = await setHouseBand(h, c);
      // Show what was stored, even when it reads the same as before ("67.0" → "67").
      const next = shownBand(saved, toDisplay);
      setDerived(next);
      setForm(next);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the house band");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="house-band" aria-labelledby="house-band-title">
      <div className="house-band-text">
        <h2 className="house-band-title" id="house-band-title">
          House
        </h2>
        <p className="house-band-help">
          {isSet
            ? "Every room is kept between these two temperatures unless a hold, a schedule or occupancy gives it its own."
            : "Set a band to keep every room between two temperatures. Without one, a room is only heated or cooled by a hold, a schedule or occupancy."}
        </p>
      </div>
      <div className="house-band-fields">
        <label className="field-stack">
          {`Heat To (${unitLabel})`}
          <input
            className="form-control house-band-input"
            type="number"
            inputMode="decimal"
            step="any"
            value={form.heat}
            disabled={saving}
            onChange={(e) => setForm({ ...form, heat: e.target.value })}
          />
        </label>
        <label className="field-stack">
          {`Cool To (${unitLabel})`}
          <input
            className="form-control house-band-input"
            type="number"
            inputMode="decimal"
            step="any"
            value={form.cool}
            disabled={saving}
            onChange={(e) => setForm({ ...form, cool: e.target.value })}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !valid || !dirty}
          onClick={() => void send(heat, cool)}
        >
          {isSet ? "Save" : "Set House Band"}
        </button>
        {isSet && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={saving}
            onClick={() => setConfirmOff(true)}
          >
            Turn Off
          </button>
        )}
      </div>
      <p className="house-band-hint">{`Cool To must be at least ${gap}° above Heat To.`}</p>
      {error && <p className="form-error">{error}</p>}
      {confirmOff && (
        <ConfirmDialog
          title="Turn off the house band?"
          message="Rooms that only follow the house band stop asking for heating or cooling straight away, which ends any cycle running just for them."
          confirmLabel="Turn Off"
          onCancel={() => setConfirmOff(false)}
          onConfirm={() => {
            setConfirmOff(false);
            void send(null, null);
          }}
        />
      )}
    </section>
  );
}
