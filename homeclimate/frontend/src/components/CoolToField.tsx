import { useUnit } from "../contexts";

/**
 * An optional Cooling Target beside a Heating Target, which makes a range.
 *
 * Holds the display-unit text as typed; the backend converts on the way in.
 */
export default function CoolToField({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (text: string) => void;
}) {
  const { unitLabel } = useUnit();
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>
        Cooling Target ({unitLabel})
      </label>
      <input
        id={id}
        className="form-control"
        type="number"
        step="0.5"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Same as heating"
      />
      <div className="form-hint">Leave empty, or use the same number, to keep one temperature.</div>
    </div>
  );
}
