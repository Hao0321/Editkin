import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledFontFaceSpec, bundledFontFaceSpecs } from "./bundledFontCatalog";
import { resolveBundledFontFace } from "./fontFaces";

describe("compiled physical font catalog", () => {
  it("binds all 43 physical identities to the actual licensed manifest, without accepting its own alternate digest", async () => {
    const raw = await readFile(resolve("public/fonts/editkin-open-fonts.json"));
    const manifest = JSON.parse(raw.toString("utf8"));
    const expectedManifestSha = createHash("sha256").update(raw).digest("hex");
    const specs = bundledFontFaceSpecs();
    expect(specs).toHaveLength(43);
    expect(Object.isFrozen(specs)).toBe(true);
    expect(new Set(specs.map(spec => spec.faceId)).size).toBe(43);
    expect(manifest.fonts.flatMap((font: { faces: unknown[] }) => font.faces)).toHaveLength(43);
    for (const font of manifest.fonts) for (const physical of font.faces) {
      const spec = bundledFontFaceSpec(physical.id);
      expect(Object.isFrozen(spec)).toBe(true);
      expect(spec).toEqual({ faceId: physical.id, fontFamily: physical.family, fontWeight: physical.weight,
        fontFile: physical.file, sha256: physical.sha256, manifestSha256: expectedManifestSha });
      expect(Object.keys(spec).sort()).toEqual(["faceId", "fontFamily", "fontFile", "fontWeight", "manifestSha256", "sha256"].sort());
      expect(resolveBundledFontFace(font.family, physical.weight)).toMatchObject({ faceId: spec.faceId,
        fontFile: spec.fontFile, fontFamily: spec.fontFamily, fontWeight: spec.fontWeight });
    }
  });

  it("requires exact resolved weight instead of interpreting a requested weight, logical family or guessed filename", () => {
    const requested = resolveBundledFontFace("Fredoka", 850)!;
    expect(requested.fontWeight).toBe(700);
    expect(bundledFontFaceSpec(requested.faceId).fontWeight).toBe(700);
    expect(() => bundledFontFaceSpec("EditkinFace-fredoka-850")).toThrow(/Unknown/);
  });

  it.each(["Noto Sans TC", "EditkinFace noto-sans-tc 700", "render/EditkinFace-noto-sans-tc-700.ttf",
    "../EditkinFace-noto-sans-tc-700", "EditkinFace-noto-sans-tc-700/../../outside", "https://example.test/font.ttf",
    "__proto__", "toString", "EditkinFace-noto-sans-tc-700 ", "editkinface-noto-sans-tc-700", "", "x".repeat(97)])(
    "rejects unlisted request %j", value => expect(() => bundledFontFaceSpec(value)).toThrow(/Unknown/));

  it("cannot mutate the shared catalog through its returned record or enumeration", () => {
    const spec = bundledFontFaceSpec("EditkinFace-bebas-neue-400");
    expect(() => { (spec as { sha256: string }).sha256 = "0".repeat(64); }).toThrow();
    expect(() => { (bundledFontFaceSpecs() as unknown[]).push({}); }).toThrow();
    expect(bundledFontFaceSpec(spec.faceId)).toBe(spec);
  });
});
