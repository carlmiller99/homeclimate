import { useState } from "react";

/** A whole-minute input that saves on blur or Enter. */
export function MinutesInput({
  value,
  min,
  max,
  label,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  disabled?: boolean;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    // A save or refetch changed the stored value: show it (adjust during render).
    setShown(value);
    setDraft(String(value));
  }
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isInteger(n) || n < min || n > max) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <span className="minutes-field">
      <input
        className="form-control minutes-input"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className="minutes-unit">min</span>
    </span>
  );
}

export function Switch({
  id,
  checked,
  label,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  label?: string;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <input
      id={id}
      className="switch"
      type="checkbox"
      role="switch"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function RuleRow({
  id,
  title,
  help,
  enabled,
  disabled,
  onToggle,
  group,
  children,
}: {
  id: string;
  title: string;
  help: string;
  enabled?: boolean;
  disabled?: boolean;
  onToggle?: (v: boolean) => void;
  /** The row holds a set of controls that name themselves, not one field. */
  group?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rule-row">
      {onToggle ? (
        <Switch id={id} checked={!!enabled} disabled={disabled} onChange={onToggle} />
      ) : (
        <span className="switch-spacer" />
      )}
      <div className="rule-text">
        {group ? (
          <span className="rule-title">{title}</span>
        ) : (
          <label htmlFor={onToggle ? id : `${id}-min`} className="rule-title">
            {title}
          </label>
        )}
        <p className="rule-help">{help}</p>
      </div>
      <div className={`rule-value${onToggle && !enabled ? " is-off" : ""}`}>{children}</div>
    </div>
  );
}
