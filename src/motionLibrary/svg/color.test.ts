import { describe, expect, it } from "vitest";
import { contrastRatio, mixHex, relativeLuminance, shade, tint } from "./color";

describe("tint and shade", () => {
  it("mix toward white / black by default and toward the given palette role otherwise", () => {
    expect(tint("#FF5C8A", 0)).toBe("#FF5C8A");
    expect(tint("#FF5C8A", 1)).toBe("#FFFFFF");
    expect(shade("#FF5C8A", 1)).toBe("#000000");
    expect(tint("#FF5C8A", 0.5, "#F5F1E6")).toBe(mixHex("#FF5C8A", "#F5F1E6", 0.5));
    expect(shade("#FF5C8A", 0.4, "#121214")).toBe(mixHex("#FF5C8A", "#121214", 0.4));
    expect(tint("#FF5C8A", 2)).toBe("#FFFFFF"); // amount is clamped like mixHex
  });
  it("tints are lighter and shades darker than the colour", () => {
    const accent = "#FF5C8A";
    expect(relativeLuminance(tint(accent, 0.5, "#F5F1E6"))).toBeGreaterThan(relativeLuminance(accent));
    expect(relativeLuminance(shade(accent, 0.5, "#121214"))).toBeLessThan(relativeLuminance(accent));
    expect(contrastRatio(tint(accent, 0.5, "#F5F1E6"), accent)).toBeGreaterThan(1.3); // a visible step between the X01 planes
  });
});
