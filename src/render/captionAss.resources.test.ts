import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import type { EditProject, MotionGraphic } from "../domain/types";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import * as composition from "../motion/compositionV2";
import type { MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { ASS_MOTION_LIMITS, AssMotionBudget, assMotionFrameRange, assUtf8Bytes } from "./assMotionBudget";
import { admitAssMotionProject, assMotionFrameTime, writeAssContent } from "./captionAss";

let latinRun: PreparedGlyphRun, hanRun: PreparedGlyphRun, repeatedHanRun: PreparedGlyphRun;
beforeAll(async () => {
  const root = resolve("public/fonts"), latin = bundledFontFaceSpec("EditkinFace-bebas-neue-400"), han = bundledFontFaceSpec("EditkinFace-noto-sans-tc-700");
  const latinBytes = new Uint8Array(await readFile(join(root, latin.fontFile)));
  const hanBytes = new Uint8Array(await readFile(join(root, han.fontFile)));
  // Actual compiled parser/bytes/contours. No font, layout or frame stubs.
  latinRun = await prepareGlyphRun(latin.faceId, "AV", latinBytes);
  hanRun = await prepareGlyphRun(han.faceId, "漢", hanBytes);
  repeatedHanRun = await prepareGlyphRun(han.faceId, "漢".repeat(128), hanBytes);
});
afterEach(() => vi.restoreAllMocks());

function project(): EditProject { return createEmptyProject("ASS resource controls", { width: 1080, height: 1920, fps: 30 }); }
function textGraphic(id = "physical", text = "AV", frames = 4, family = "Bebas Neue"): MotionGraphic {
  const graphic = createMotionGraphic(id, "title", text, 1, frames / 30, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  graphic.fontFamily = family; graphic.fontWeight = family === "Bebas Neue" ? 400 : 700;
  graphic.fontSize = 60; graphic.letterSpacing = 0; graphic.backgroundColor = "#00000000";
  graphic.outlineWidth = 0; graphic.shadowDepth = 0;
  graphic.layoutV2 = { ...graphic.layoutV2!, widthMode: "fit_content", align: "left", minFontSize: 60 };
  graphic.motionV2 = {
    sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
    entrance: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "linear" } },
    exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "linear" } },
  };
  return graphic;
}
function physical(p: EditProject, graphic: MotionGraphic, run = latinRun) {
  p.motionGraphics = [graphic];
  const layout = composition.motionGraphicV2PhysicalLayoutReceipt(p, graphic, run);
  return { layout, options: { requirePhysicalGlyphs: true, physicalLayouts: new Map([[graphic.id, layout]]) } };
}
function dialogues(ass: string) { return ass.split("\n").filter(line => line.startsWith("Dialogue: ")); }
function twoLayerVectors(): EditProject {
  const p = project();
  p.motionGraphics = ["foreground", "background"].map((layer, index) => {
    const graphic = createMotionGraphic(`dots-${index}`, "card", "", 1, 4 / 30, undefined, findMotionGraphicPreset("reel_dot_grid").seed);
    if (graphic.vectorV2?.kind !== "dot_grid") throw new Error("Actual dot-grid preset required");
    graphic.compositeLayer = layer as "foreground" | "background";
    if (layer === "background") graphic.vectorV2.schema = "editkin.motion-vector-stage/v1";
    graphic.width = .3;
    graphic.vectorV2.heightPixels = 128; graphic.vectorV2.spacingPixels = 16;
    graphic.vectorV2.dotRadiusPixels = 2; graphic.vectorV2.revealFrames = 1;
    graphic.motionV2 = textGraphic().motionV2;
    return graphic;
  });
  return p;
}

describe("ASS aggregate admission and actual retention boundaries", () => {
  it("counts genuine UTF-8 and final newline bytes without retaining a rejected line", () => {
    const text = "A漢é😀\ud800", bytes = new TextEncoder().encode(text).length;
    expect(bytes).toBe(13); expect(assUtf8Bytes(text)).toBe(bytes);
    const budget = new AssMotionBudget({ sampleEvaluations: 2, events: 2, utf8Bytes: bytes + 1 });
    budget.addLine(text); budget.addLine("");
    expect(budget.finish()).toBe(text + "\n");
    expect(budget.snapshot().actual.utf8Bytes).toBe(bytes + 1);
    const before = budget.snapshot();
    expect(() => budget.addLine("x")).toThrow(/ASS UTF-8.*budget/);
    expect(budget.snapshot()).toEqual(before); expect(budget.finish()).toBe(text + "\n");
  });

  it("rejects the next actual event before retention, including embedded event newlines", () => {
    const budget = new AssMotionBudget({ sampleEvaluations: 2, events: 2, utf8Bytes: 100 });
    budget.addLine("; comment\nDialogue: one"); budget.addLine("Dialogue: two");
    expect(budget.snapshot().actual.events).toBe(2);
    const before = budget.snapshot();
    expect(() => budget.addLine("Dialogue: three")).toThrow(/ASS event.*budget/);
    expect(budget.snapshot()).toEqual(before);
    expect(budget.finish()).not.toContain("three");
  });

  it("bounds additive admission and actual samples without committing a failed charge", () => {
    const budget = new AssMotionBudget({ sampleEvaluations: 2, events: 3, utf8Bytes: 20 });
    budget.admit({ sampleEvaluations: 1, events: 2, utf8Bytes: 10 });
    budget.admit({ sampleEvaluations: 1, events: 1, utf8Bytes: 10 });
    const before = budget.snapshot();
    expect(() => budget.admit({ events: 1 })).toThrow(/event.*budget/);
    expect(() => budget.admit({ sampleEvaluations: Infinity })).toThrow(/sample.*budget/);
    expect(budget.snapshot()).toEqual(before);
    budget.takeSample(); budget.takeSample();
    expect(() => budget.takeSample()).toThrow(/sample.*budget/);
    expect(budget.snapshot().actual.sampleEvaluations).toBe(2);
  });

  it("preserves the complete normal caption-only output bytes and trailing newline", () => {
    const p = createEmptyProject("literal", { width: 320, height: 180, fps: 30 });
    p.captions = [{ id: "cue", start: 1, duration: 2, text: "Hi,漢" }];
    const style = { ...p.captionStyle, fontFamily: "Fixture Sans", translationFontFamily: "Fixture Sans", bold: false };
    const expected = [
      "[Script Info]", "ScriptType: v4.00+", "PlayResX: 320", "PlayResY: 180", "YCbCr Matrix: None",
      "WrapStyle: 0", "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
      "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
      "Style: Default,Fixture Sans,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,1,4,1,2,40,40,72,1",
      "Style: Motion,Fixture Sans,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,1,4,1,2,40,40,72,1",
      "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\fnFixture Sans\\b400}Hi，漢", "",
    ].join("\n");
    expect(writeAssContent(p, style, { bundledFaces: false })).toBe(expected);
    expect(new TextEncoder().encode(expected).length).toBe(assUtf8Bytes(expected));
  });

  it("keeps each physical frame/contour and doubles only the authored shadow contours", () => {
    const p = project(), graphic = textGraphic(), { layout, options } = physical(p, graphic);
    const plain = writeAssContent(p, p.captionStyle, options), events = dialogues(plain);
    expect(events).toHaveLength(3); // One all-unit contour per frame; final exit frame has no ink.
    expect(events.map(line => line.split(",")[1])).toEqual(["0:00:01.00", "0:00:01.03", "0:00:01.06"]);
    expect(events.every(line => line.endsWith(layout.segments[0].outline!.ass + "{\\p0}"))).toBe(true);
    expect(events.every(line => line.includes("\\fscx100\\fscy100\\bord0\\shad0"))).toBe(true);
    graphic.shadowDepth = 2.75;
    const shadow = dialogues(writeAssContent(p, p.captionStyle, options));
    expect(shadow).toHaveLength(6);
    expect(shadow.every(line => line.endsWith(layout.segments[0].outline!.ass + "{\\p0}"))).toBe(true);
    expect(shadow.filter((_, index) => index % 2 === 1)).toEqual(events);
    expect(JSON.stringify(p.motionGraphics[0].motionV2)).toContain('"durationFrames":1');
  });

  it("keeps missing physical receipts strict after resource admission", () => {
    const p = project(); p.motionGraphics = [textGraphic()];
    expect(() => writeAssContent(p, p.captionStyle, { requirePhysicalGlyphs: true })).toThrow(/glyph.*receipt/);
    expect(() => writeAssContent(p, p.captionStyle, { requirePhysicalGlyphs: true, physicalLayouts: new Map() })).toThrow(/glyph.*receipt/);
  });

  it("admits all layer sample work before any layout or frame expansion", () => {
    const p = project(), frame = vi.spyOn(composition, "motionGraphicV2FrameReceipt");
    p.motionGraphics = Array.from({ length: 7 }, (_, index) => {
      const graphic = createMotionGraphic(`vector-${index}`, "card", "", 0, 500, undefined, findMotionGraphicPreset("reel_rule_reveal").seed);
      if (index % 2) { graphic.compositeLayer = "background"; if (graphic.vectorV2?.kind === "rule") graphic.vectorV2.schema = "editkin.motion-vector-stage/v1"; }
      return graphic;
    });
    // Each is below 18,000; the project has 105,000 samples across both layers.
    expect(p.motionGraphics.every(graphic => graphic.duration * p.fps === 15_000)).toBe(true);
    expect(() => writeAssContent(p, p.captionStyle)).toThrow(/ASS sample.*budget/);
    expect(() => writeAssContent(p, p.captionStyle, { compositeLayer: "background" })).toThrow(/ASS sample.*budget/);
    expect(frame).not.toHaveBeenCalled();
  });

  it("rejects nonfinite/unsafe frame ranges and the original per-graphic ceiling before expansion", () => {
    const p = project(), graphic = textGraphic(), frame = vi.spyOn(composition, "motionGraphicV2FrameReceipt");
    p.motionGraphics = [graphic];
    for (const duration of [Infinity, NaN, Number.MAX_VALUE]) {
      graphic.duration = duration;
      expect(() => writeAssContent(p, p.captionStyle)).toThrow(/ASS sample.*budget/);
    }
    graphic.duration = 601; graphic.text = "A";
    expect(() => writeAssContent(p, p.captionStyle)).toThrow(/18000/);
    expect(() => assMotionFrameRange(Number.MAX_SAFE_INTEGER, 1, 30)).toThrow(/unsafe/);
    // Finite input and a safe two-frame duration can still overflow ASS's
    // derived timestamp. Admit the endpoints before any expansion loop.
    expect(() => assMotionFrameRange(0, 2e307, 1e-307)).toThrow(/derived.*timestamp/);
    expect(() => assMotionFrameTime(1, 1e-307)).toThrow(/derived.*timestamp/);
    expect(() => assMotionFrameTime(Number.MAX_SAFE_INTEGER, 1)).toThrow(/centiseconds/);
    expect(assMotionFrameRange(0, 4, .5)).toEqual({ startFrame: 0, durationFrames: 2 });
    expect(assMotionFrameTime(1, .5)).toBe("0:00:02.00");
    expect(frame).not.toHaveBeenCalled();
  });

  it("rejects aggregate captions before creating any event array", () => {
    const p = project();
    p.captions = Array(ASS_MOTION_LIMITS.events + 1).fill({ id: "same-readable-cue", start: 0, duration: 1, text: "x" });
    expect(() => writeAssContent(p, p.captionStyle)).toThrow(/ASS event.*budget/);
    expect(() => writeAssContent(p, p.captionStyle, { compositeLayer: "background" })).toThrow(/ASS event.*budget/);
  });

  it("includes v1 tracked-point work even when points emit no visible events", () => {
    const p = project(), graphic = createMotionGraphic("legacy", "title", "legacy", 0, 3);
    graphic.trackId = "tracked"; p.motionGraphics = [graphic];
    p.motionTracks = [{ id: "tracked", clipId: "none", name: "control", engine: "fixture", analysisFps: 30,
      initialRect: { x: 0, y: 0, width: .1, height: .1 }, lostRatio: 1, createdAt: "2026-10-01T00:00:00Z",
      points: Array(ASS_MOTION_LIMITS.sampleEvaluations + 1).fill({ frame: 0, time: 0, rect: { x: 0, y: 0, width: .1, height: .1 }, confidence: 0, status: "lost" }) }];
    expect(() => writeAssContent(p, p.captionStyle)).toThrow(/ASS sample.*budget/);
  });

  it("charges authentic repeated shadow contours before a single frame evaluation", () => {
    const p = project(), graphic = textGraphic("han", "漢", 4, "Noto Sans TC");
    const initial = physical(p, graphic, hanRun).layout;
    const bytes = initial.segments.reduce((sum, segment) => sum + assUtf8Bytes(segment.outline!.ass), 0);
    const frames = Math.floor(ASS_MOTION_LIMITS.utf8Bytes / (2 * (bytes + 512))) + 1;
    // This actual face must exercise the bound while honoring the old 18,000 ceiling.
    expect(bytes).toBeGreaterThan(0); expect(frames).toBeGreaterThan(2); expect(frames).toBeLessThanOrEqual(18_000);
    graphic.duration = frames / p.fps;
    const { options } = physical(p, graphic, hanRun);
    const admitted = admitAssMotionProject(p, p.captionStyle, options).snapshot();
    expect(admitted.estimate.utf8Bytes).toBeLessThan(ASS_MOTION_LIMITS.utf8Bytes);
    expect(admitted.actual).toEqual({ sampleEvaluations: 0, events: 0, utf8Bytes: 0 });
    graphic.shadowDepth = 2.75;
    const frame = vi.spyOn(composition, "motionGraphicV2FrameReceipt");
    expect(() => writeAssContent(p, p.captionStyle, options)).toThrow(/ASS UTF-8.*budget/);
    expect(frame).not.toHaveBeenCalled();
  });

  it("blocks aggregate real foreground contour copies without forging a large receipt", () => {
    const p = createEmptyProject("real contour copies", { width: 4096, height: 4096, fps: 30 });
    const seed = textGraphic("han-0", repeatedHanRun.text, 60, "Noto Sans TC");
    seed.fontSize = 32; seed.layoutV2 = { ...seed.layoutV2!, minFontSize: 32, maxLines: 4 };
    const authentic = composition.motionGraphicV2PhysicalLayoutReceipt(p, seed, repeatedHanRun);
    const payloadPerGraphic = authentic.segments.reduce((sum, segment) => sum + assUtf8Bytes(segment.outline!.ass), 0) * 60;
    const count = Math.floor(ASS_MOTION_LIMITS.utf8Bytes / payloadPerGraphic) + 1;
    expect(payloadPerGraphic).toBeGreaterThan(0); expect(count).toBeLessThanOrEqual(128);
    const layouts = new Map<string, MotionGraphicV2LayoutReceipt>();
    p.motionGraphics = Array.from({ length: count }, (_, index) => {
      const graphic = { ...structuredClone(seed), id: `han-${index}`, compositeLayer: "foreground" as const };
      layouts.set(graphic.id, composition.motionGraphicV2PhysicalLayoutReceipt(p, graphic, repeatedHanRun)); return graphic;
    });
    const frame = vi.spyOn(composition, "motionGraphicV2FrameReceipt");
    expect(() => writeAssContent(p, p.captionStyle, { requirePhysicalGlyphs: true, physicalLayouts: layouts })).toThrow(/ASS UTF-8.*budget/);
    expect(frame).not.toHaveBeenCalled();
  });

  it("shares actual two-layer vector bytes/work at the exact bound without joining their scripts", () => {
    const p = twoLayerVectors();
    const foreground = writeAssContent(p, p.captionStyle);
    const background = writeAssContent(p, p.captionStyle, { compositeLayer: "background" });
    const bytes = assUtf8Bytes(foreground) + assUtf8Bytes(background);
    const provider = new AssMotionBudget({ sampleEvaluations: 8, events: 8, utf8Bytes: bytes });
    // Genuine dense paths exceed the partial source allowance; the actual
    // shared sink supplies the byte guarantee across these valid vector layers.
    expect(bytes).toBeGreaterThan(admitAssMotionProject(p, p.captionStyle).snapshot().estimate.utf8Bytes);
    expect(writeAssContent(p, p.captionStyle, { aggregateBudget: provider })).toBe(foreground);
    expect(writeAssContent(p, p.captionStyle, { compositeLayer: "background", aggregateBudget: provider })).toBe(background);
    expect(provider.snapshot().actual).toEqual({ sampleEvaluations: 8, events: 6, utf8Bytes: bytes });
    expect(provider.snapshot().lines).toBe(0);
    expect(provider.finish()).toBe("");
    expect(provider.snapshot().estimate).toEqual({ sampleEvaluations: 0, events: 0, utf8Bytes: 0 });
  });

  it("blocks a one-byte combined overrun even when both valid vector scripts individually fit", () => {
    const p = twoLayerVectors();
    const foreground = writeAssContent(p, p.captionStyle);
    const background = writeAssContent(p, p.captionStyle, { compositeLayer: "background" });
    const bytes = assUtf8Bytes(foreground) + assUtf8Bytes(background);
    const provider = new AssMotionBudget({ sampleEvaluations: 8, events: 8, utf8Bytes: bytes - 1 });
    expect(assUtf8Bytes(foreground)).toBeLessThan(bytes - 1);
    expect(assUtf8Bytes(background)).toBeLessThan(bytes - 1);
    expect(writeAssContent(p, p.captionStyle, { aggregateBudget: provider })).toBe(foreground);
    expect(() => writeAssContent(p, p.captionStyle, { compositeLayer: "background", aggregateBudget: provider })).toThrow(/ASS UTF-8.*budget/);
    // The final empty line needs one newline byte. Its failed charge cannot
    // mutate a counter; already admitted earlier records stay truthfully charged.
    expect(provider.snapshot().actual).toEqual({ sampleEvaluations: 8, events: 6, utf8Bytes: bytes - 1 });
    expect(provider.snapshot().lines).toBe(0);
  });
});
