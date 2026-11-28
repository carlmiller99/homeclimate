/** What a target reads as: one temperature, or a heat-to and cool-to pair. */
export function bandText(
  fmtTemp: (f: number) => string,
  target: number,
  coolTo: number | null | undefined
): string {
  return coolTo == null ? fmtTemp(target) : `${fmtTemp(target)} to ${fmtTemp(coolTo)}`;
}

/** What to send for a Cooling Target: nothing typed, or the Heating Target's
 *  own number, means one temperature. */
export function coolToValue(text: string, heat?: number): number | null {
  const cool = text.trim() === "" ? null : parseFloat(text);
  return cool === heat ? null : cool;
}

/**
 * A Heating Target and a Cooling Target as they are stored: the heating one
 * is the target, and a cooling one above it makes it a range. The same number
 * in both is one temperature, kept as one.
 */
export function targetPair(
  heatText: string,
  coolText: string
): { target: number | null; coolTo: number | null } | "need heat" | "crossed" {
  const heat = heatText.trim() === "" ? null : parseFloat(heatText);
  const cool = coolText.trim() === "" ? null : parseFloat(coolText);
  if (heat == null) return cool == null ? { target: null, coolTo: null } : "need heat";
  if (cool == null || cool === heat) return { target: heat, coolTo: null };
  return cool < heat ? "crossed" : { target: heat, coolTo: cool };
}
