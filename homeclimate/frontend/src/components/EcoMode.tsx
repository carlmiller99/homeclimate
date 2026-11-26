/**
 * The shared Eco Mode live dual cooling/heating worked example (Issue #404),
 * used by both the Thermostats and Rooms config pages. The field catalog and
 * relaxation math live in ``../eco``; this file holds only the component so
 * fast-refresh stays happy.
 */

import { useUnit } from "../contexts";
import { ecoRelaxedTarget, type EcoExampleParams } from "../eco";

/**
 * The live dual worked example. ``params`` are the effective values in DISPLAY
 * units (already resolved for inheritance on the room page). A sample indoor
 * target of 70 °F / 21 °C matches the driving example in the docs.
 */
export function EcoWorkedExample({ params }: { params: EcoExampleParams }) {
  const { unitLabel, isCelsius } = useUnit();
  const indoor = isCelsius ? 21 : 70;
  const fmt = (v: number) => `${Math.round(v * 10) / 10}${unitLabel}`;
  const coolRelaxed = ecoRelaxedTarget(indoor, "cooling", params.coolingFullDrift, params);
  const heatRelaxed = ecoRelaxedTarget(indoor, "heating", params.heatingFullDrift, params);

  return (
    <div className="form-hint" data-testid="eco-worked-example">
      <strong>Example:</strong> a {fmt(indoor)} room stays at {fmt(indoor)} until it is{" "}
      {fmt(params.coolingThreshold)} outside, then drifts up to {fmt(coolRelaxed)} at most. In
      heating it drifts down to {fmt(heatRelaxed)} at most, starting at{" "}
      {fmt(params.heatingThreshold)} outside.
    </div>
  );
}
