import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveBundledFontFace } from "./fontFaces";

describe("shared physical font selection", () => {
  it.each([400, 650, 700, 800, 850, 900])("keeps authored Sans weight %s exact", weight => {
    expect(resolveBundledFontFace("Noto Sans TC", weight)).toEqual({
      fontFamily: `EditkinFace noto-sans-tc ${weight}`, fontWeight: weight,
      fontFile: `render/EditkinFace-noto-sans-tc-${weight}.ttf`, faceId: `EditkinFace-noto-sans-tc-${weight}`,
      requestedWeight: weight, weightSubstituted: false,
    });
  });
  it("resolves bounds and ties explicitly without pretending continuous variations", () => {
    expect(resolveBundledFontFace("Noto Sans TC", 825)).toMatchObject({ fontWeight: 800, requestedWeight: 825, weightSubstituted: true });
    expect(resolveBundledFontFace("Noto Sans TC", 826)).toMatchObject({ fontWeight: 850 });
    expect(resolveBundledFontFace("Noto Serif TC", 100)).toMatchObject({ fontWeight: 200, weightSubstituted: true });
    expect(resolveBundledFontFace("Fredoka", 800)).toMatchObject({ fontWeight: 700, weightSubstituted: true });
    expect(resolveBundledFontFace("Fredoka", 650)).toMatchObject({ fontWeight: 650, weightSubstituted: false });
    expect(resolveBundledFontFace("Bebas Neue", 700)).toMatchObject({ fontWeight: 400, weightSubstituted: true });
    expect(resolveBundledFontFace("LXGW WenKai Mono TC", 400)).toMatchObject({ fontWeight: 400, weightSubstituted: false });
  });
  it.each([NaN, Infinity, -Infinity, 0, 99, 901])("rejects invalid weight %s", weight => {
    expect(() => resolveBundledFontFace("Noto Sans TC", weight)).toThrow(/字重/);
  });
  it("does not certify or silently substitute a custom family", () => {
    expect(resolveBundledFontFace("Missing Font", 700)).toBeUndefined();
    expect(resolveBundledFontFace("Noto Serif TC Black", 900)).toBeUndefined();
  });
  it("agrees with actual canonical manifest faces across every declared family/weight", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../public/fonts/editkin-open-fonts.json", import.meta.url), "utf8"));
    expect(manifest.schemaVersion).toBe(2);
    let count = 0;
    for (const font of manifest.fonts) for (const face of font.faces) {
      const selected = resolveBundledFontFace(font.family, face.weight)!;
      expect(selected).toMatchObject({ fontFamily: face.family, fontWeight: face.weight, fontFile: face.file, faceId: face.id, weightSubstituted: false });
      count++;
    }
    expect(count).toBe(43);
  });
});
