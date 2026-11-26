import { useUnit } from "../contexts";

/**
 * An optional Cool To beside a target, which turns the target into a band.
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
        Cool To ({unitLabel})
        <span className="text-muted" style={{ fontWeight: 400, marginLeft: ".5rem" }}>
          — optional
        </span>
      </label>
      <input
        id={id}
        className="form-control"
        type="number"
        step="0.5"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Single target"
      />
      <div className="form-hint">
        Leave blank to hold one temperature. Fill it in and the room is kept between the two
        temperatures.
      </div>
    </div>
  );
}
