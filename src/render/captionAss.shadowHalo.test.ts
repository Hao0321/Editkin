import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import type { MotionGraphic } from "../domain/types";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "../application/projectCodec";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { writeAssContent } from "./captionAss";

const FACE_ID = "EditkinFace-noto-sans-tc-700";
let glyphs: PreparedGlyphRun;
beforeAll(async () => {
  const face = bundledFontFaceSpec(FACE_ID);
  const bytes = new Uint8Array(await readFile(resolve(process.env.EDITKIN_FONT_ROOT ?? "public/fonts", face.fontFile)));
  glyphs = await prepareGlyphRun(face.faceId, "水簾", bytes);
});

function title(halo?: number): MotionGraphic {
  const graphic = createMotionGraphic("halo-title", "title", "水簾", 1, 3 / 30, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  Object.assign(graphic, { fontFamily: "Noto Sans TC", fontWeight: 700, fontSize: 96, letterSpacing: 0, x: .08, y: .3, width: .8,
    backgroundColor: "#00000000", textColor: "#FFFFFF", accentColor: "#0000008C", shadowDepth: 3, outlineWidth: 0,
    layoutV2: { safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, maxLines: 1, minFontSize: 96, lineGap: 0, align: "left" },
    motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
      entrance: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } },
      exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } } } });
  if (halo !== undefined) graphic.shadowBlurPixels = halo;
  return graphic;
}
function ass(halo?: number) {
  const project = parseProject(createDemoProject()), text = title(halo);
  const physical = motionGraphicV2PhysicalLayoutReceipt(project, text, glyphs);
  project.motionGraphics = [text];
  return writeAssContent(project, project.captionStyle, { requirePhysicalGlyphs: true, physicalLayouts: new Map([[text.id, physical]]) })
    .split("\n").filter(line => line.startsWith("Dialogue: 2,"));
}

describe("soft shadow halo for v2 physical glyphs", () => {
  it("softens only the shadow copy, scaled per frame, and leaves the glyph sharp", () => {
    const events = ass(9.6);
    const shadows = events.filter(line => line.includes("\\1c&H000000&")), glyphsOnly = events.filter(line => line.includes("\\1c&HFFFFFF&"));
    expect(shadows.length).toBeGreaterThan(0); expect(glyphsOnly.length).toBe(shadows.length);
    expect(shadows.every(line => /\\blur9\.6\b/.test(line))).toBe(true);
    expect(glyphsOnly.some(line => line.includes("\\blur"))).toBe(false);
  });
  it("keeps omitted halos byte-identical to the historical crisp shadow", () => {
    const historical = ass(), explicitZero = ass(0);
    expect(historical.some(line => line.includes("\\blur"))).toBe(false);
    expect(explicitZero).toEqual(historical);
  });
  it("survives save/reopen and is rejected outside v2 physical text", () => {
    const project = parseProject(createDemoProject()), text = title(12);
    const saved = applyCommand(project, { type: "add_motion_graphic", graphic: text });
    expect(decodeProjectBytes(encodeProjectBytes(saved)).motionGraphics.find(graphic => graphic.id === text.id)?.shadowBlurPixels).toBe(12);
    expect(() => applyCommand(project, { type: "add_motion_graphic", graphic: { ...text, id: "halo-too-wide", shadowBlurPixels: 65 } })).toThrow();
    expect(() => applyCommand(project, { type: "add_motion_graphic", graphic: { ...text, id: "halo-v1", schema: "hao.motion-composition/v1" } })).toThrow(/柔和陰影|v2/);
  });
});
