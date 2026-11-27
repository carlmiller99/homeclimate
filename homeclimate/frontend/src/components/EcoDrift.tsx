import { useUnit } from "../contexts";
import type { EcoExampleParams } from "../eco";

const W = 520;
const H = 150;
const MID = 75;
const AMP = 44;

/**
 * A picture of what the Eco settings do: rooms hold their target between the
 * two outside temperatures, and drift further the more extreme it gets.
 * ``params`` are display units, as the form holds them.
 */
export function EcoChart({ params }: { params: EcoExampleParams }) {
  const { unitLabel } = useUnit();
  const fmt = (v: number) => `${Math.round(v * 10) / 10}${unitLabel}`;
  const cold = Math.min(params.heatingFullDrift, params.heatingThreshold);
  const hot = Math.max(params.coolingFullDrift, params.coolingThreshold);
  const pad = Math.max((hot - cold) * 0.08, 1);
  const lo = cold - pad;
  const span = hot + pad - lo;
  const x = (t: number) => 20 + ((t - lo) / span) * (W - 40);
  const most = Math.max(params.coolingMaxDrift, params.heatingMaxDrift, 0.1);
  const y = (drift: number) => MID - (drift / most) * AMP;
  const points = [
    [20, y(-params.heatingMaxDrift)],
    [x(cold), y(-params.heatingMaxDrift)],
    [x(params.heatingThreshold), MID],
    [x(params.coolingThreshold), MID],
    [x(hot), y(params.coolingMaxDrift)],
    [W - 20, y(params.coolingMaxDrift)],
  ]
    .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
    .join(" ");
  const says = `Rooms hold their target between ${fmt(params.heatingThreshold)} and ${fmt(params.coolingThreshold)} outside. Colder than that they run up to ${fmt(params.heatingMaxDrift)} cooler; hotter, up to ${fmt(params.coolingMaxDrift)} warmer.`;
  return (
    <svg className="eco-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={says}>
      <line className="eco-chart-zero" x1="20" y1={MID} x2={W - 20} y2={MID} />
      <polyline className="eco-chart-line" points={points} />
      <circle className="eco-chart-heat" cx={x(params.heatingThreshold)} cy={MID} r="6" />
      <circle className="eco-chart-cool" cx={x(params.coolingThreshold)} cy={MID} r="6" />
      <text
        className="eco-chart-text"
        x={x(params.heatingThreshold)}
        y={MID + 25}
        textAnchor="middle"
      >
        {`${fmt(params.heatingThreshold)} outside`}
      </text>
      <text
        className="eco-chart-text"
        x={x(params.coolingThreshold)}
        y={MID + 25}
        textAnchor="middle"
      >
        {`${fmt(params.coolingThreshold)} outside`}
      </text>
      <text className="eco-chart-text eco-chart-heat" x="20" y={H - 8}>
        {`${fmt(params.heatingMaxDrift)} cooler`}
      </text>
      <text className="eco-chart-text eco-chart-cool" x={W - 20} y="16" textAnchor="end">
        {`${fmt(params.coolingMaxDrift)} warmer`}
      </text>
    </svg>
  );
}

/** A labelled slider that shows its value. The range always holds the value. */
export function EcoSlider({
  id,
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const { unitLabel } = useUnit();
  return (
    <div className="eco-slider">
      <div className="eco-slider-head">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        <strong>{`${value}${unitLabel}`}</strong>
      </div>
      <input
        id={id}
        type="range"
        min={Math.min(min, Math.floor(value))}
        max={Math.max(max, Math.ceil(value))}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
