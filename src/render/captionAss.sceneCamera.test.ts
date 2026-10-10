import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import type { EditProject, MotionGraphic } from "../domain/types";
import type { MotionScene2D } from "../domain/motionScene2d";
import type { SpringTargetTrack } from "../domain/motionContinuity";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { motionPanelPaths } from "../motion/panelGeometry";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { AssMotionBudget } from "./assMotionBudget";
import { writeAssContent } from "./captionAss";

let run: PreparedGlyphRun;
beforeAll(async () => {
  const spec = bundledFontFaceSpec("EditkinFace-bebas-neue-400");
  run = await prepareGlyphRun(spec.faceId, "AV", new Uint8Array(await readFile(resolve("public/fonts", spec.fontFile))));
});
function constant(value: number): SpringTargetTrack {
  return { fps: 30, initialPosition: value, initialTarget: value, initialVelocity: 0,
    spring: { stiffness: 100, damping: 20, mass: 1 }, events: [] };
}
function title(): MotionGraphic {
  const g = createMotionGraphic("title", "title", "AV", 0, 2, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  g.x = .15; g.y = .15; g.width = .7; g.fontFamily = "Bebas Neue"; g.fontWeight = 400;
  g.fontSize = 40; g.letterSpacing = 0; g.outlineWidth = 2; g.shadowDepth = 2.75;
  g.backgroundColor = "#17202C"; g.textColor = "#FFFFFF"; g.accentColor = "#123456";
  g.layoutV2 = { ...g.layoutV2!, widthMode: "fit_content", minFontSize: 40, maxLines: 1, align: "left" };
  g.motionV2 = { sequence: { unit: "character", order: "forward", exitOrder: "forward", staggerFrames: 0 },
    entrance: { durationFrames: 12, offsetXPixels: 3.125, offsetYPixels: 4.25, scale: .73123, opacity: .4, easing: { type: "linear" } },
    exit: { durationFrames: 4, offsetXPixels: 0, offsetYPixels: -2.25, scale: .98765, opacity: 0, easing: { type: "linear" } } };
  return g;
}
function vector(): MotionGraphic {
  const g = createMotionGraphic("vector", "card", "", 0, 2, undefined, findMotionGraphicPreset("reel_native_disc").seed);
  g.x = .35; g.y = .25; g.width = .2;
  if (!g.vectorV2) throw new Error("Actual original vector preset required");
  g.vectorV2.heightPixels = 24; g.vectorV2.revealFrames = 1;
  g.motionV2 = title().motionV2;
  g.motionV2!.sequence.unit = "all";
  return g;
}
function scene(ids: string[]): MotionScene2D {
  return { schema: "editkin.motion-scene-2d/v1", id: "original-focus", startFrame: 0, durationFrames: 60, fps: 30,
    graphicIds: ids, camera: { centerX: constant(100), centerY: constant(60), zoom: constant(1.25) },
    safeArea: { left: 8, right: 8, top: 8, bottom: 8 },
    semanticCues: [{ id: "source-cue", frame: 15, purpose: "Focus the original source caption at its declared time",
      graphicIds: [ids[0]], evidenceRefs: ["caption:source-cue"] }] };
}
function fixture(kind: "text" | "vector" = "text") {
  const p = createEmptyProject("Original scene source adapter; no pixel/playback proof", { width: 320, height: 180, fps: 30 });
  p.captions = [{ id: "source-cue", start: .5, duration: .5, text: "Focus AV" }];
  const g = kind === "text" ? title() : vector(); p.motionGraphics = [g]; p.motionScenes = [scene([g.id])];
  const layout = kind === "text" ? motionGraphicV2PhysicalLayoutReceipt(p, g, run) : motionGraphicV2LayoutReceipt(p, g);
  const layouts = new Map([[g.id, layout]]);
  return { p, g, layout, layouts };
}
function selected(ass: string, layer: number, start = "0:00:00.20") {
  return ass.split("\n").filter(line => line.startsWith(`Dialogue: ${layer},${start},`)).map(line => {
    const tags = /,,(\{[^}]+\})(.*)\{\\p0\}$/.exec(line);
    if (!tags) throw new Error("Actual drawing event required");
    const pos = /\\pos\(([^,]+),([^)]+)\)/.exec(tags[1]);
    const scale = /\\fscx([^\\}]+)\\fscy([^\\}]+)/.exec(tags[1]);
    if (!pos || !scale) throw new Error("Projected position and explicit scale required");
    return { tags: tags[1], path: tags[2], x: Number(pos[1]), y: Number(pos[2]), scaleX: Number(scale[1]), scaleY: Number(scale[2]) };
  });
}
function write(p: EditProject, layouts: ReturnType<typeof fixture>["layouts"]) {
  return writeAssContent(p, p.captionStyle, { physicalLayouts: layouts, requirePhysicalGlyphs: true });
}

describe("actual ASS scene2d projection (original fixtures, genuine font, no pixel/playback proof)", () => {
  it("projects actual glyph origins/scales and the already-scaled shadow through the literal affine map", () => {
    const { p, g, layout, layouts } = fixture(), frame = motionGraphicV2FrameReceipt(p, g, 6, layout);
    const events = selected(write(p, layouts), 2);
    expect(events).toHaveLength(layout.segments.length * 2);
    // For this authored constant camera: x'=1.25*x+35, y'=1.25*y+15.
    frame.segments.forEach((state, index) => {
      const segment = layout.segments[index], shadow = events[index * 2], primary = events[index * 2 + 1];
      expect(primary.path).toBe(segment.outline!.ass); expect(shadow.path).toBe(primary.path);
      expect(primary.x).toBeCloseTo(1.25 * (segment.x + state.translateXPixels) + 35, 5);
      expect(primary.y).toBeCloseTo(1.25 * (segment.y + state.translateYPixels) + 15, 5);
      expect(primary.scaleX).toBeCloseTo(125 * state.scale, 5); expect(primary.scaleY).toBe(primary.scaleX);
      expect(shadow.scaleX).toBe(primary.scaleX);
      expect(shadow.x - primary.x).toBeCloseTo(2.75 * state.scale * 1.25, 5);
      expect(shadow.y - primary.y).toBeCloseTo(2.75 * state.scale * 1.25, 5);
      expect(primary.tags).toContain("\\bord0\\shad0");
      expect(primary.tags).not.toMatch(/\\fn|\\fs(?!c)|\\fsp/);
    });
    expect(write(p, layouts)).toContain("; MotionSceneCamera2DReceipt: title,original-focus,");
  });

  it("projects panel fill and inner border with the same origin and camera scale", () => {
    const { p, g, layout, layouts } = fixture(), panel = motionPanelPaths(layout.box.width, layout.box.height, g.cornerRadius ?? 10, g.outlineWidth ?? 2);
    const events = selected(write(p, layouts), 1);
    expect(events).toHaveLength(2);
    expect(events.map(event => event.path)).toEqual([panel.fillAss, panel.borderAss]);
    for (const event of events) {
      expect(event.x).toBeCloseTo(1.25 * layout.box.x + 35, 5);
      expect(event.y).toBeCloseTo(1.25 * layout.box.y + 15, 5);
      expect(event.scaleX).toBe(125); expect(event.scaleY).toBe(125);
    }
  });

  it("projects genuine vector origins and multiplies camera and local noninteger scale", () => {
    const { p, g, layout, layouts } = fixture("vector"), frame = motionGraphicV2FrameReceipt(p, g, 6, layout), state = frame.vectorState!;
    const events = selected(write(p, layouts), 1), paths = motionVectorPaths(g, layout, frame);
    expect(events.map(event => event.path)).toEqual(paths.map(path => path.ass));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.x).toBeCloseTo(1.25 * (layout.box.x + state.translateXPixels) + 35, 5);
      expect(event.y).toBeCloseTo(1.25 * (layout.box.y + state.translateYPixels) + 15, 5);
      expect(event.scaleX).toBeCloseTo(125 * state.scale, 5);
      expect(event.scaleX % 1).not.toBe(0);
    }
  });

  it("keeps source output deterministic after nonmonotonic frames and schema9 JSON reopen", () => {
    const { p, g, layout, layouts } = fixture();
    p.motionScenes![0].camera.centerX.events = [{ frame: 15, target: 112 }];
    p.motionScenes![0].camera.zoom.events = [{ frame: 15, target: 1.3 }];
    const before = JSON.stringify(p), ass = write(p, layouts);
    const receipts = [6, 21, 4, 6].map(frame => motionGraphicV2FrameReceipt(p, g, frame, layout));
    expect(receipts.at(-1)).toEqual(receipts[0]);
    const reopened = JSON.parse(before) as EditProject;
    expect(write(reopened, layouts)).toBe(ass); expect(write(p, layouts)).toBe(ass);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("hard blocks scene text without a physical receipt and scoped v1 graphics", () => {
    const { p, layouts } = fixture();
    expect(() => writeAssContent(p, p.captionStyle)).toThrow(/scene2d.*physical glyph.*estimated/);
    expect(() => writeAssContent(p, p.captionStyle, { physicalLayouts: new Map() })).toThrow(/physical glyph/);
    p.motionGraphics = [createMotionGraphic("title", "title", "AV", 0, 2, undefined, legacyMotionGraphicSeed("title"))];
    expect(() => write(p, layouts)).toThrow(/foreground.*v2/);
  });

  it("rejects actual projected ink outside the declared safe area before retaining ASS output", () => {
    const { p, layouts } = fixture(), provider = new AssMotionBudget();
    p.motionScenes![0].camera.centerX.initialPosition = 1000;
    p.motionScenes![0].camera.centerX.initialTarget = 1000;
    expect(() => writeAssContent(p, p.captionStyle, { physicalLayouts: layouts, aggregateBudget: provider })).toThrow(/actual ink\/contour.*safe-area/);
    expect(provider.snapshot().actual).toEqual({ sampleEvaluations: 0, events: 0, utf8Bytes: 0 });
  });

  it("keeps unscoped legacy/estimated text at its original screen positions", () => {
    const { p, layouts } = fixture("vector");
    const legacy = createMotionGraphic("legacy", "title", "LEGACY", 0, 2), estimated = title();
    estimated.id = "estimated"; estimated.text = "KEEP";
    estimated.motionV2!.sequence.unit = "all";
    p.motionGraphics.push(legacy, estimated);
    const sceneOutput = writeAssContent(p, p.captionStyle, { physicalLayouts: layouts });
    const baseline = writeAssContent({ ...p, motionScenes: [] }, p.captionStyle, { physicalLayouts: layouts });
    const textLines = (value: string) => value.split("\n").filter(line => line.startsWith("Dialogue: ") && (line.includes("LEGACY") || line.endsWith("KEEP")));
    expect(textLines(sceneOutput)).toEqual(textLines(baseline));
    expect(textLines(sceneOutput).length).toBeGreaterThan(1);
  });

  it("preserves byte-equivalent physical output when the project has no scene", () => {
    const { p, layouts } = fixture(); delete p.motionScenes;
    const baseline = write(p, layouts);
    expect(write({ ...p, motionScenes: [] }, layouts)).toBe(baseline);
    expect(baseline).not.toContain("MotionSceneCamera2DReceipt");
  });
});
