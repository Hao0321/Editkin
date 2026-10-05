import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import type { EditProject, MotionGraphic } from "../domain/types";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import {
  motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt,
  type MotionGraphicV2LayoutReceipt,
} from "../motion/compositionV2";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { writeAssContent } from "./captionAss";
import { prepareMotionPhysicalLayouts } from "./motionPhysicalGlyphLayouts";

const fontRoot = resolve("public/fonts");
const latinFaceId = "EditkinFace-bebas-neue-400";
const hanFaceId = "EditkinFace-noto-sans-tc-700";
const hanCandidates = "jJfTAVy漢g";
let latinBytes: Uint8Array, hanBytes: Uint8Array;
let latinRun: PreparedGlyphRun, hanRun: PreparedGlyphRun;
const ownedBases: string[] = [];

beforeAll(async () => {
  // Genuine compiled faces: no parser/reader mocks, synthetic contours or copied brands.
  latinBytes = new Uint8Array(await readFile(join(fontRoot, bundledFontFaceSpec(latinFaceId).fontFile)));
  hanBytes = new Uint8Array(await readFile(join(fontRoot, bundledFontFaceSpec(hanFaceId).fontFile)));
  latinRun = await prepareGlyphRun(latinFaceId, "AV", latinBytes);
  hanRun = await prepareGlyphRun(hanFaceId, hanCandidates, hanBytes);
});

afterEach(async () => {
  for (const base of ownedBases.splice(0)) await rm(base, { recursive: true, force: true });
});

function project(): EditProject {
  return createEmptyProject("Physical ASS adapter", { width: 1080, height: 1920, fps: 30 });
}

function textGraphic(text = "AV", id = "physical-title", family = "Bebas Neue"): MotionGraphic {
  const graphic = createMotionGraphic(id, "title", text, 1, 2, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  graphic.fontFamily = family;
  graphic.fontWeight = family === "Bebas Neue" ? 400 : 700;
  graphic.fontSize = 60;
  graphic.letterSpacing = 0;
  graphic.backgroundColor = "#00000000";
  graphic.outlineWidth = 0;
  graphic.shadowDepth = 0;
  graphic.layoutV2 = { ...graphic.layoutV2!, widthMode: "fit_content", align: "left", minFontSize: 60 };
  graphic.motionV2 = {
    sequence: { unit: "character", order: "forward", exitOrder: "forward", staggerFrames: 0 },
    entrance: { durationFrames: 12, offsetXPixels: 3.123456, offsetYPixels: 9.654321,
      scale: .73123, opacity: .4, easing: { type: "linear" } },
    exit: { durationFrames: 4, offsetXPixels: 0, offsetYPixels: -2.345678,
      scale: .98765, opacity: 0, easing: { type: "linear" } },
  };
  return graphic;
}

function fixture() {
  const p = project(), graphic = textGraphic();
  p.motionGraphics = [graphic];
  const layout = motionGraphicV2PhysicalLayoutReceipt(p, graphic, latinRun);
  return { p, graphic, layout, layouts: new Map([[graphic.id, layout]]) };
}

interface DrawingEvent { start: string; end: string; tags: string; path: string; }
function glyphEvents(ass: string): DrawingEvent[] {
  return ass.split("\n").filter(line => line.startsWith("Dialogue: 2,")).map(line => {
    // Parse the fixed ASS fields before the payload; \pos itself contains a comma.
    const fields = /^Dialogue: 2,([^,]+),([^,]+),Motion,,0,0,0,,(\{[^}]+\})(.*)\{\\p0\}$/.exec(line);
    if (!fields) throw new Error(`Malformed physical drawing event: ${line}`);
    return { start: fields[1], end: fields[2], tags: fields[3], path: fields[4] };
  });
}
function transform(event: DrawingEvent) {
  const pos = /\\pos\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/.exec(event.tags);
  const xScale = /\\fscx(-?\d+(?:\.\d+)?)/.exec(event.tags);
  const yScale = /\\fscy(-?\d+(?:\.\d+)?)/.exec(event.tags);
  if (!pos || !xScale || !yScale) throw new Error("Missing physical frame transform");
  return { x: Number(pos[1]), y: Number(pos[2]), xScale: Number(xScale[1]), yScale: Number(yScale[1]) };
}
function write(p: EditProject, layouts?: ReadonlyMap<string, MotionGraphicV2LayoutReceipt>, layer: "foreground" | "background" = "foreground") {
  return writeAssContent(p, p.captionStyle, { requirePhysicalGlyphs: true, physicalLayouts: layouts, compositeLayer: layer });
}

async function copiedLatinPack() {
  const base = await mkdtemp(join(tmpdir(), "editkin-physical-ass-"));
  ownedBases.push(base);
  const root = join(base, "pack"), spec = bundledFontFaceSpec(latinFaceId), font = join(root, spec.fontFile);
  await mkdir(join(root, "render"), { recursive: true });
  await copyFile(join(fontRoot, "editkin-open-fonts.json"), join(root, "editkin-open-fonts.json"));
  await copyFile(join(fontRoot, spec.fontFile), font);
  return { root, font };
}

describe("physical glyph receipt to ASS adapter", () => {
  it("passes authentic local contours and exact physical identity, without libass text shaping", () => {
    const { p, graphic, layout, layouts } = fixture(), before = JSON.stringify(p);
    const ass = write(p, layouts), spec = bundledFontFaceSpec(latinFaceId);
    expect(ass).toContain(`; MotionCompositionV2Receipt: ${graphic.id},${layout.receiptId},60`);
    expect(ass).toContain(`; MotionPhysicalGlyph: ${graphic.id},${latinFaceId},${spec.sha256},${spec.manifestSha256},opentype.js@1.3.4`);
    const events = glyphEvents(ass);
    expect(events).toHaveLength(118);
    for (const event of events) {
      expect(layout.segments.some(segment => segment.outline!.ass === event.path)).toBe(true);
      expect(event.tags).toContain("\\an7\\q2\\p1\\pos(");
      expect(event.tags).toContain("\\bord0\\shad0");
      expect(event.tags).not.toMatch(/\\(?:fn|fs(?!c)|b(?!ord)|fsp)/);
      expect(event.path).not.toMatch(/[AV]/);
    }
    expect(events[0].start).toBe("0:00:01.00");
    // Exit opacity reaches zero at local frame 59, so its final interval emits no ink.
    expect(events.at(-1)!.start).toBe("0:00:02.93");
    expect(events.at(-1)!.end).toBe("0:00:02.96");
    expect(events.some(event => event.start === "0:00:03.00")).toBe(false);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("uses half-open output-frame intervals and the shared origin/scale after nonmonotonic seeks", () => {
    const { p, graphic, layout, layouts } = fixture();
    const ass = write(p, layouts), events = glyphEvents(ass);
    const receipts = [33, 52, 31, 41, 33].map(frame => motionGraphicV2FrameReceipt(p, graphic, frame, layout));
    expect(receipts.at(-1)).toEqual(receipts[0]);
    // Independent expected timestamps at 30 fps: floor to centiseconds, never round up.
    const intervals = [[33, "0:00:01.10", "0:00:01.13"], [41, "0:00:01.36", "0:00:01.40"],
      [52, "0:00:01.73", "0:00:01.76"]] as const;
    for (const [timelineFrame, start, end] of intervals) {
      const frame = motionGraphicV2FrameReceipt(p, graphic, timelineFrame, layout);
      const selected = events.filter(event => event.start === start && event.end === end);
      expect(selected).toHaveLength(frame.segments.length);
      frame.segments.forEach((state, index) => {
        const segment = layout.segments.find(item => item.id === state.segmentId)!;
        expect(selected[index].path).toBe(segment.outline!.ass);
        const emitted = transform(selected[index]);
        expect(emitted.x).toBeCloseTo(segment.x + state.translateXPixels, 5);
        expect(emitted.y).toBeCloseTo(segment.y + state.translateYPixels, 5);
        expect(emitted.xScale).toBeCloseTo(state.scale * 100, 5);
        expect(emitted.yScale).toBe(emitted.xScale);
        if (timelineFrame === 33) expect(Math.abs(emitted.xScale - Math.round(emitted.xScale))).toBeGreaterThan(.01);
      });
    }
    expect(events.filter(event => event.start === "0:00:01.13")[0].end).toBe("0:00:01.16");
    expect(write(p, layouts)).toBe(ass);
  });

  it.each(["foreground", "background"] as const)(
    "matches the shared scaled local shadow on the %s layer without automatic libass shadow", layer => {
      const { p, graphic, layout, layouts } = fixture();
      graphic.compositeLayer = layer;
      graphic.shadowDepth = 2.75;
      graphic.textColor = "#FEDCBA";
      graphic.accentColor = "#123456";
      const events = glyphEvents(write(p, layouts, layer));
      expect(events).toHaveLength(236);
      const selected = events.filter(event => event.start === "0:00:01.10" && event.end === "0:00:01.13");
      const frame = motionGraphicV2FrameReceipt(p, graphic, 33, layout);
      expect(selected).toHaveLength(frame.segments.length * 2);
      frame.segments.forEach((state, index) => {
        const segment = layout.segments.find(item => item.id === state.segmentId)!;
        const shadow = selected[index * 2], primary = selected[index * 2 + 1];
        // Draw order is the local SVG order: the same shadow contour, then the main contour.
        expect(shadow.path).toBe(segment.outline!.ass);
        expect(primary.path).toBe(shadow.path);
        expect(shadow.tags).toContain("\\1c&H563412&");
        expect(primary.tags).toContain("\\1c&HBADCFE&");
        expect(shadow.tags).toContain("\\1a&H6F&");
        expect(primary.tags).toContain("\\1a&H6F&");
        for (const event of [shadow, primary]) {
          expect(event.tags).toContain("\\an7\\q2\\p1\\pos(");
          expect(event.tags).toContain("\\bord0\\shad0");
        }
        const shadowTransform = transform(shadow), primaryTransform = transform(primary);
        expect(primaryTransform.x).toBeCloseTo(segment.x + state.translateXPixels, 5);
        expect(primaryTransform.y).toBeCloseTo(segment.y + state.translateYPixels, 5);
        expect(primaryTransform.xScale).toBeCloseTo(state.scale * 100, 5);
        expect(shadowTransform.xScale).toBe(primaryTransform.xScale);
        expect(shadowTransform.yScale).toBe(primaryTransform.yScale);
        // SVG translate(depth, depth) is inside scale(state.scale), so script-pixel
        // shadow translation is depth * scale, not an unscaled \shad value.
        const offset = 2.75 * state.scale;
        expect(shadowTransform.x - primaryTransform.x).toBeCloseTo(offset, 5);
        expect(shadowTransform.y - primaryTransform.y).toBeCloseTo(offset, 5);
        expect(Math.abs(shadowTransform.x - primaryTransform.x - 2.75)).toBeGreaterThan(.1);
        expect(Math.abs(primaryTransform.xScale - Math.round(primaryTransform.xScale))).toBeGreaterThan(.01);
      });
      // An omitted shadow has the same explicit absence as zero; no legacy default of two.
      delete graphic.shadowDepth;
      const withoutShadow = glyphEvents(write(p, layouts, layer));
      expect(withoutShadow).toHaveLength(118);
      expect(withoutShadow.every(event => event.tags.includes("\\shad0") && event.tags.includes("\\1c&HBADCFE&"))).toBe(true);
    });

  it("retains real Han-face negative bearing and descender with no ink-origin or font-top shift", () => {
    const negativeIndex = hanRun.glyphs.findIndex(glyph => (glyph.inkEm?.xMin ?? 0) < 0);
    const descenderIndex = hanRun.glyphs.findIndex(glyph => (glyph.inkEm?.yMax ?? 0) > 0);
    // This bounded real character set must supply both controls. No skip or synthetic fallback.
    expect(negativeIndex).toBeGreaterThanOrEqual(0);
    expect(descenderIndex).toBeGreaterThanOrEqual(0);
    expect(hanRun.glyphs.some(glyph => glyph.text === "漢" && glyph.pathCommands.length > 0)).toBe(true);
    const p = project(), graphic = textGraphic(hanCandidates, "han-bearing", "Noto Sans TC");
    p.motionGraphics = [graphic];
    const layout = motionGraphicV2PhysicalLayoutReceipt(p, graphic, hanRun);
    const selected = glyphEvents(write(p, new Map([[graphic.id, layout]]))).filter(event => event.start === "0:00:01.10");
    const frame = motionGraphicV2FrameReceipt(p, graphic, 33, layout);
    const hanIndex = hanRun.glyphs.findIndex(glyph => glyph.text === "漢");
    expect(selected[hanIndex].path).toBe(layout.segments[hanIndex].outline!.ass);
    for (const index of new Set([negativeIndex, descenderIndex])) {
      const segment = layout.segments[index], glyph = hanRun.glyphs[index], state = frame.segments[index];
      expect(selected[index].path).toBe(segment.outline!.ass);
      const emitted = transform(selected[index]), ink = segment.outline!.ink!;
      expect(emitted.x).toBeCloseTo(segment.x + state.translateXPixels, 5);
      expect(emitted.y).toBeCloseTo(segment.y + state.translateYPixels, 5);
      if (index === negativeIndex) {
        expect(ink.xMin).toBeLessThan(0);
        expect(ink.xMin).toBeCloseTo(glyph.inkEm!.xMin * layout.fontSize, 4);
        expect(emitted.x + ink.xMin * emitted.xScale / 100).toBeLessThan(emitted.x);
      }
      if (index === descenderIndex) {
        expect(ink.yMax).toBeGreaterThan(segment.baselinePixels!);
        expect(ink.yMax - segment.baselinePixels!).toBeCloseTo(glyph.inkEm!.yMax * layout.fontSize, 4);
      }
    }
  });

  it.each(["missing-map", "missing-entry", "estimated", "wrong-graphic", "ass-body", "missing-outline"] as const)(
    "hard blocks a %s layout instead of estimating or re-shaping", control => {
      const { p, graphic, layout } = fixture();
      let layouts: ReadonlyMap<string, MotionGraphicV2LayoutReceipt> | undefined = new Map([[graphic.id, layout]]);
      if (control === "missing-map") layouts = undefined;
      if (control === "missing-entry") layouts = new Map();
      if (control === "estimated") layouts = new Map([[graphic.id, motionGraphicV2LayoutReceipt(p, graphic)]]);
      if (control === "wrong-graphic") {
        const other = textGraphic("AV", "another-title");
        layouts = new Map([[graphic.id, motionGraphicV2PhysicalLayoutReceipt(p, other, latinRun)]]);
      }
      if (control === "ass-body" || control === "missing-outline") {
        const altered = structuredClone(layout);
        if (control === "ass-body") altered.segments[0].outline!.ass += " l 1 1";
        else delete altered.segments[0].outline;
        layouts = new Map([[graphic.id, altered]]);
      }
      expect(() => write(p, layouts)).toThrow(/glyph|receipt/);
    });

  it.each(["text", "face", "weight", "project-size", "position", "physical-sha"] as const)(
    "rejects the supplied receipt after %s drift", control => {
      const { p, graphic, layout, layouts } = fixture();
      if (control === "text") graphic.text = "NEW";
      if (control === "face") graphic.fontFamily = "Fredoka";
      if (control === "weight") graphic.fontWeight = 700;
      if (control === "project-size") p.width += 1;
      if (control === "position") graphic.x += .01;
      if (control === "physical-sha") {
        const altered = structuredClone(layout); altered.physicalFont!.fontSha256 = "0".repeat(64);
        layouts.set(graphic.id, altered);
      }
      expect(() => write(p, layouts)).toThrow(/glyph|receipt/);
    });

  it("forwards distinct physical receipts to foreground and background, excluding the other layer", async () => {
    const p = project(), foreground = textGraphic("AV", "front"), background = textGraphic(hanCandidates, "back", "Noto Sans TC");
    background.compositeLayer = "background";
    p.motionGraphics = [foreground, background];
    const layouts = await prepareMotionPhysicalLayouts(p, fontRoot);
    expect([...layouts.keys()]).toEqual(["front", "back"]);
    const front = write(p, layouts), back = write(p, layouts, "background");
    expect(front).toContain(`; MotionPhysicalGlyph: front,${latinFaceId},`);
    expect(front).not.toContain("; MotionPhysicalGlyph: back,");
    expect(back).toContain(`; MotionPhysicalGlyph: back,${hanFaceId},`);
    expect(back).not.toContain("; MotionPhysicalGlyph: front,");
    expect(glyphEvents(front)[0].path).toBe(layouts.get("front")!.segments[0].outline!.ass);
    expect(glyphEvents(back)[0].path).toBe(layouts.get("back")!.segments[0].outline!.ass);
    const missingBack = new Map(layouts); missingBack.delete("back");
    expect(() => write(p, missingBack, "background")).toThrow(/glyph.*back.*receipt/);
    expect(write(p, missingBack)).toBe(front);
  });

  it("keeps vector-only output independent of physical font delivery", async () => {
    const p = project();
    p.motionGraphics = [createMotionGraphic("vector", "card", "", 1, 2, undefined, findMotionGraphicPreset("reel_rule_reveal").seed)];
    const layouts = await prepareMotionPhysicalLayouts(p);
    expect(layouts.size).toBe(0);
    const strict = write(p, layouts);
    expect(strict).toBe(writeAssContent(p, p.captionStyle));
    expect(strict).toContain("; MotionCompositionV2Receipt: vector,");
    expect(strict).not.toContain("; MotionPhysicalGlyph:");
    expect(strict).toContain("\\p1");
    expect(glyphEvents(strict)).toHaveLength(0);
  });
});

describe("actual font-pack preparation boundary for ASS", () => {
  it("prepares the selected copied face, then rejects same-size corruption in that exact root", async () => {
    const { p, graphic, layout } = fixture(), f = await copiedLatinPack();
    const copied = await prepareMotionPhysicalLayouts(p, f.root);
    expect(copied.get(graphic.id)!.receiptId).toBe(layout.receiptId);
    expect(write(p, copied)).toContain(layout.segments[0].outline!.ass);
    const corrupt = new Uint8Array(latinBytes); corrupt[corrupt.length - 1] ^= 1;
    await writeFile(f.font, corrupt);
    await expect(prepareMotionPhysicalLayouts(p, f.root)).rejects.toThrow(/size or SHA/);
  });

  it("does not silently replace missing, relative, libass render-directory or missing-face roots", async () => {
    const { p } = fixture(), f = await copiedLatinPack();
    await expect(prepareMotionPhysicalLayouts(p)).rejects.toThrow(/glyph.*pack root/);
    await expect(prepareMotionPhysicalLayouts(p, "public/fonts")).rejects.toThrow(/absolute/);
    await expect(prepareMotionPhysicalLayouts(p, join(fontRoot, "render"))).rejects.toThrow(/ENOENT/);
    await rm(f.font);
    await expect(prepareMotionPhysicalLayouts(p, f.root)).rejects.toThrow(/ENOENT/);
  });

  it("rejects unsupported face/text, invisible-only text and duplicate IDs through real preparation", async () => {
    const p = project(), graphic = textGraphic(); p.motionGraphics = [graphic];
    graphic.fontFamily = "Unlisted Custom Font";
    await expect(prepareMotionPhysicalLayouts(p, fontRoot)).rejects.toThrow(/glyph.*內建字型/);
    graphic.fontFamily = "Bebas Neue"; graphic.text = "漢";
    await expect(prepareMotionPhysicalLayouts(p, fontRoot)).rejects.toMatchObject({ reason: "MISSING_GLYPH" });
    graphic.text = "A\u0301";
    await expect(prepareMotionPhysicalLayouts(p, fontRoot)).rejects.toMatchObject({ reason: "TEXT" });
    graphic.text = "";
    await expect(prepareMotionPhysicalLayouts(p, fontRoot)).rejects.toThrow(/glyph.*沒有可見輪廓/);
    graphic.text = "AV"; p.motionGraphics = [graphic, structuredClone(graphic)];
    await expect(prepareMotionPhysicalLayouts(p, fontRoot)).rejects.toThrow(/identity.*重複/);
  });

  it("rejects 129 text graphics before attempting a supplied nonexistent font root", async () => {
    const p = project();
    p.motionGraphics = Array.from({ length: 129 }, (_, index) => textGraphic("AV", `limit-${index}`));
    await expect(prepareMotionPhysicalLayouts(p, join(fontRoot, "uncreated-limit-root"))).rejects.toThrow(/128.*文字圖形/);
  });

  it("rejects the aggregate outline budget with genuine contours rather than a forged large receipt", async () => {
    const p = createEmptyProject("Bounded physical outlines", { width: 4096, height: 4096, fps: 30 });
    const text = "漢".repeat(128), run = await prepareGlyphRun(hanFaceId, text, hanBytes);
    const seed = textGraphic(text, "outline-0", "Noto Sans TC");
    seed.fontSize = 32;
    seed.motionV2!.sequence.unit = "all";
    seed.layoutV2 = { ...seed.layoutV2!, minFontSize: 32, maxLines: 4 };
    const authentic = motionGraphicV2PhysicalLayoutReceipt(p, seed, run);
    const cost = authentic.segments.reduce((sum, segment) => sum + segment.outline!.svg.length + segment.outline!.ass.length, 0);
    const needed = Math.floor(8 * 1024 * 1024 / cost) + 1;
    // If this actual face stops exercising the cap, fail the fixture instead of weakening the guard.
    expect(cost).toBeGreaterThan(0);
    expect(needed).toBeLessThanOrEqual(128);
    p.motionGraphics = Array.from({ length: needed }, (_, index) => ({ ...structuredClone(seed), id: `outline-${index}` }));
    await expect(prepareMotionPhysicalLayouts(p, fontRoot)).rejects.toThrow(/輪廓資料.*有界預算/);
  });
});
