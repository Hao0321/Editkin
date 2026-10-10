import { describe, expect, it } from "vitest";
import { brandMotionContrast, resolveBrandMotionPalette, type BrandMotionPaletteRoles } from "./brandMotionPalette";

const roles = (): BrandMotionPaletteRoles => ({ primary: "#3366CC", background: "#ffffff", ink: "#111111", grid: "#cccccc" });

describe("original four-role motion palette", () => {
  it("normalizes exactly four sRGB roles into owned deeply frozen values", () => {
    const input = roles(), result = resolveBrandMotionPalette(input);
    expect(result.roles.primary).toBe("#3366cc");
    expect(result.schema).toBe("editkin.brand-motion-palette/v1");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.roles)).toBe(true);
    expect(Object.isFrozen(result.tokens)).toBe(true);
    expect(Object.isFrozen(result.advisory)).toBe(true);
    (input as { primary: string }).primary = "#ff0000";
    expect(result.roles.primary).toBe("#3366cc");
  });

  it("chooses whichever black or white has greater contrast on the editable primary", () => {
    expect(resolveBrandMotionPalette({ ...roles(), primary: "#000000" }).tokens.onPrimary).toBe("#ffffff");
    expect(resolveBrandMotionPalette({ ...roles(), primary: "#ffffff" }).tokens.onPrimary).toBe("#000000");
    const result = resolveBrandMotionPalette(roles()), alternative = result.tokens.onPrimary === "#000000" ? "#ffffff" : "#000000";
    expect(brandMotionContrast(result.roles.primary, result.tokens.onPrimary)).toBeGreaterThanOrEqual(brandMotionContrast(result.roles.primary, alternative));
  });

  it("resolves opaque derived colors and shadow alpha with fixed known byte results", () => {
    const light = resolveBrandMotionPalette({ primary: "#000000", background: "#ffffff", ink: "#000000", grid: "#123456" });
    expect(light.surfaceBackgroundWeight).toBe(0);
    expect(light.tokens).toMatchObject({ surface: "#ffffff", muted: "#383838", line: "#dbdbdb", grid: "#123456",
      shadow: "#00000014", shadowLight: "#00000008" });
    const dark = resolveBrandMotionPalette({ ...roles(), background: "#000000" });
    expect(dark.surfaceBackgroundWeight).toBe(.88);
    expect(dark.tokens.surface).toBe("#1f1f1f");
  });

  it("keeps the fourth grid role independently editable without changing other derived tokens", () => {
    const first = resolveBrandMotionPalette(roles()), changed = resolveBrandMotionPalette({ ...roles(), grid: "#abc123" });
    expect(changed.roles.grid).toBe("#abc123");
    expect(changed.tokens.grid).toBe("#abc123");
    expect({ ...changed.tokens, grid: first.tokens.grid }).toEqual(first.tokens);
    expect(changed.advisory).toEqual(first.advisory);
    expect(resolveBrandMotionPalette(roles())).toEqual(first);
  });

  it("reports only main text versus background contrast without claiming universal token readability", () => {
    const good = resolveBrandMotionPalette({ ...roles(), ink: "#000000", background: "#ffffff" });
    expect(good.advisory).toEqual({ scope: "main-text/background-only", contrast: 21, lowContrast: false });
    const bad = resolveBrandMotionPalette({ ...roles(), ink: "#777777", background: "#777777" });
    expect(bad.advisory).toEqual({ scope: "main-text/background-only", contrast: 1, lowContrast: true });
  });

  it("rejects missing extra shorthand transparent URL and malformed color roles", () => {
    expect(() => resolveBrandMotionPalette({ primary: "#000000" } as BrandMotionPaletteRoles)).toThrow(/exactly four/);
    expect(() => resolveBrandMotionPalette({ ...roles(), fifth: "#ffffff" } as BrandMotionPaletteRoles)).toThrow(/exactly four/);
    expect(() => resolveBrandMotionPalette({ ...roles(), primary: "#fff" })).toThrow(/#RRGGBB/);
    expect(() => resolveBrandMotionPalette({ ...roles(), ink: "#00000080" })).toThrow(/#RRGGBB/);
    expect(() => resolveBrandMotionPalette({ ...roles(), grid: "url(https://example.test/color)" })).toThrow(/#RRGGBB/);
    expect(() => resolveBrandMotionPalette({ ...roles(), background: "rgba(0,0,0,1)" })).toThrow(/#RRGGBB/);
    expect(() => brandMotionContrast("garbage", "#ffffff")).toThrow(/#RRGGBB/);
  });
});
