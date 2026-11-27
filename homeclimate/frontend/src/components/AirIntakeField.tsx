import Segmented from "./Segmented";
import { AIR_INTAKE_LABELS, type AirIntake } from "../fanApi";

/** My Home → Edit Zone: whether the air handler draws in outside air. */
export default function AirIntakeField({
  zoneName,
  value,
  onChange,
}: {
  zoneName: string;
  value: AirIntake;
  onChange: (value: AirIntake) => void;
}) {
  return (
    <Segmented
      label={`Outside air intake for ${zoneName}`}
      value={value}
      options={(Object.keys(AIR_INTAKE_LABELS) as AirIntake[]).map((k) => ({
        value: k,
        label: AIR_INTAKE_LABELS[k],
      }))}
      onChange={onChange}
    />
  );
}
