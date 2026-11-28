/** The days of the week as buttons, each on or off. Monday is 0. */
export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function DayChips({
  label,
  selected,
  disabled,
  onToggle,
}: {
  label: string;
  selected: number[];
  disabled?: boolean;
  onToggle: (day: number) => void;
}) {
  return (
    <div className="day-picker" role="group" aria-label={label}>
      {DAY_NAMES.map((name, day) => (
        <button
          key={name}
          type="button"
          className={`day-btn${selected.includes(day) ? " selected" : ""}`}
          aria-pressed={selected.includes(day)}
          disabled={disabled}
          onClick={() => onToggle(day)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
