/** What a target reads as: one temperature, or a heat-to and cool-to pair. */
export function bandText(
  fmtTemp: (f: number) => string,
  target: number,
  coolTo: number | null | undefined
): string {
  return coolTo == null ? fmtTemp(target) : `${fmtTemp(target)} to ${fmtTemp(coolTo)}`;
}

/** What to send for a cool-to field: nothing typed means a single target. */
export function coolToValue(text: string): number | null {
  return text.trim() === "" ? null : parseFloat(text);
}
