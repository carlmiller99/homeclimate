import { describe, expect, it } from "vitest";
import { bandText, coolToValue, targetPair } from "./bands";

describe("bands", () => {
  it("says a band or one temperature", () => {
    const f = (n: number) => `${n}°F`;
    expect(bandText(f, 70, null)).toBe("70°F");
    expect(bandText(f, 70, 74)).toBe("70°F to 74°F");
  });

  it("sends nothing, or the heating target's own number, as one temperature", () => {
    expect(coolToValue("")).toBeNull();
    expect(coolToValue(" 74 ")).toBe(74);
    expect(coolToValue("70", 70)).toBeNull();
    expect(coolToValue("74", 70)).toBe(74);
  });

  it("pairs a heating and a cooling target", () => {
    expect(targetPair("", "")).toEqual({ target: null, coolTo: null });
    expect(targetPair("", "74")).toBe("need heat");
    expect(targetPair("70", "")).toEqual({ target: 70, coolTo: null });
    expect(targetPair("70", "70")).toEqual({ target: 70, coolTo: null });
    expect(targetPair("70", "74")).toEqual({ target: 70, coolTo: 74 });
    expect(targetPair("74", "70")).toBe("crossed");
  });
});
