import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { assertMotionGraphicV2Contract } from "../domain/motionCompositionV2Contract";
import { motionGraphicSchema, motionVectorV2Schema } from "../domain/schema";
import type { MotionGraphic } from "../domain/types";
import { parseProject } from "../application/projectCodec";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { motionClipWindowStyle } from "../ui/motionClipWindow";
import { writeAssContent } from "./captionAss";

const FACE_ID = "EditkinFace-noto-sans-tc-700";
let glyphs: PreparedGlyphRun;

beforeAll(async () => {
  const face = bundledFontFaceSpec(FACE_ID);
  const bytes = new Uint8Array(await readFile(resolve(process.env.EDITKIN_FONT_ROOT ?? "public/fonts", face.fontFile)));
  glyphs = await prepareGlyphRun(face.faceId, "重點", bytes);
});

function motion(entranceFrames = 1, dy = 0): NonNullable<MotionGraphic["motionV2"]> {
  return {
    sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
    entrance: { durationFrames: entranceFrames, offsetXPixels: 0, offsetYPixels: dy, scale: 1, opacity: 1, easing: { type: "linear" } },
    exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "linear" } },
  };
}

function title(): MotionGraphic {
  const graphic = createMotionGraphic("rising-title", "title", "重點", 1, 12 / 30, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  graphic.fontFamily = "Noto Sans TC"; graphic.fontWeight = 700; graphic.fontSize = 48; graphic.letterSpacing = 0;
  graphic.x = .08; graphic.y = .2; graphic.width = .8;
  graphic.backgroundColor = "#FFFFFF00"; graphic.textColor = "#172033"; graphic.shadowDepth = 0; graphic.outlineWidth = 0;
  graphic.layoutV2 = { safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, maxLines: 1, minFontSize: 48, lineGap: 0, align: "left" };
  // The glyphs rise 40 px from below their own baseline window: a mask reveal.
  graphic.motionV2 = motion(8, 40);
  return graphic;
}

function vector(vectorV2: NonNullable<MotionGraphic["vectorV2"]>, frames = 12): MotionGraphic {
  const graphic = createMotionGraphic("drawn-line", "card", "", 1, frames / 30, undefined, findMotionGraphicPreset("reel_rule_reveal").seed);
  graphic.vectorV2 = vectorV2;
  graphic.x = .1; graphic.y = .2; graphic.width = .5; graphic.fontSize = 8; graphic.cornerRadius = 0; graphic.shadowDepth = 0; graphic.outlineWidth = 0;
  graphic.backgroundColor = "#2026E8"; graphic.accentColor = "#FF6B6B";
  graphic.layoutV2 = { safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" };
  graphic.motionV2 = motion();
  return graphic;
}

const events = (ass: string) => ass.split("\n").filter(line => line.startsWith("Dialogue: "));

describe("frame-space clip window", () => {
  it("clips every glyph event to the fixed window while the glyphs move through it", () => {
    const project = parseProject(createDemoProject()), text = title();
    text.clipRegion = { x: .08, y: .2, width: .8, height: .25 };
    assertMotionGraphicV2Contract(text, project.fps);
    const physical = motionGraphicV2PhysicalLayoutReceipt(project, text, glyphs);
    project.motionGraphics = [text];
    const ass = writeAssContent(project, project.captionStyle, { requirePhysicalGlyphs: true, physicalLayouts: new Map([[text.id, physical]]) });
    const lines = events(ass).filter(line => line.includes("\\p1"));
    const window = `\\clip(${Math.round(.08 * project.width * 100) / 100},${Math.round(.2 * project.height * 100) / 100},${Math.round(.88 * project.width * 100) / 100},${Math.round(.45 * project.height * 100) / 100})`;
    expect(lines.length).toBeGreaterThan(1);
    // The window never moves with the rising glyphs: the same rectangle on every frame of every segment.
    for (const line of lines) expect(line).toContain(window);
  });

  it("intersects a shape's own wipe with the window and keeps unwindowed output byte-identical", () => {
    const project = parseProject(createDemoProject());
    const shape = vector({ schema: "editkin.motion-vector-shape/v1", kind: "shape", heightPixels: 20, revealFrames: 6, revealFrom: "left",
      commands: [{ type: "M", x: 0, y: 0 }, { type: "L", x: 100, y: 0 }, { type: "L", x: 100, y: 20 }, { type: "L", x: 0, y: 20 }, { type: "Z" }] });
    project.motionGraphics = [shape];
    const plain = writeAssContent(project, project.captionStyle);
    shape.clipRegion = { x: 0, y: 0, width: .2, height: 1 };
    const windowed = writeAssContent(project, project.captionStyle);
    expect(events(plain).some(line => line.includes("\\clip("))).toBe(true);
    const right = Math.round(.2 * project.width * 100) / 100;
    for (const line of events(windowed)) {
      const clip = line.match(/\\clip\(([^)]*)\)/)![1].split(",").map(Number);
      expect(clip[2]).toBeLessThanOrEqual(right + 1e-9);
      expect(clip[0]).toBeLessThanOrEqual(clip[2]);
    }
    delete shape.clipRegion;
    expect(writeAssContent(project, project.captionStyle)).toBe(plain);
  });

  it("rejects windows outside the frame, on v1 graphics or with native paint", () => {
    const fps = 30, text = title();
    text.clipRegion = { x: .5, y: .2, width: .6, height: .2 };
    expect(() => assertMotionGraphicV2Contract(text, fps)).toThrow(/clipRegion/);
    text.clipRegion = { x: .1, y: .2, width: 0, height: .2 };
    expect(() => assertMotionGraphicV2Contract(text, fps)).toThrow(/clipRegion/);
    const legacy = createMotionGraphic("legacy", "title", "重點", 1, 1, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
    legacy.schema = "hao.motion-composition/v1"; delete legacy.motionV2; delete legacy.layoutV2; legacy.clipRegion = { x: 0, y: 0, width: .5, height: .5 };
    expect(() => assertMotionGraphicV2Contract(legacy, fps)).toThrow(/clip/);
    const parsed = motionGraphicSchema.safeParse({ ...title(), clipRegion: { x: 0, y: 0, width: .5, height: .5 } });
    expect(parsed.success && parsed.data.clipRegion).toEqual({ x: 0, y: 0, width: .5, height: .5 });
  });

  it("previews the same fixed window as a clip-path relative to the element box", () => {
    const project = parseProject(createDemoProject()), text = title();
    text.clipRegion = { x: .1, y: .2, width: .5, height: .25 };
    const camera = { scale: 1, translateX: 0, translateY: 0 } as Parameters<typeof motionClipWindowStyle>[5];
    const style = motionClipWindowStyle(project, text, { x: .1 * project.width, y: .1 * project.height }, .5 * project.width, .5 * project.height, camera);
    expect(style.clipPath).toBe("polygon(0% 20%, 100% 20%, 100% 70%, 0% 70%)");
    delete text.clipRegion;
    expect(motionClipWindowStyle(project, text, { x: 0, y: 0 }, 10, 10, camera)).toEqual({});
  });
});

describe("self-drawing stroke vector", () => {
  const circle = (cx: number, cy: number, radius: number) => {
    const k = .5522847498 * radius;
    return [{ type: "M" as const, x: cx + radius, y: cy },
      { type: "C" as const, x1: cx + radius, y1: cy + k, x2: cx + k, y2: cy + radius, x: cx, y: cy + radius },
      { type: "C" as const, x1: cx - k, y1: cy + radius, x2: cx - radius, y2: cy + k, x: cx - radius, y: cy },
      { type: "C" as const, x1: cx - radius, y1: cy - k, x2: cx - k, y2: cy - radius, x: cx, y: cy - radius },
      { type: "C" as const, x1: cx + k, y1: cy - radius, x2: cx + radius, y2: cy - k, x: cx + radius, y: cy }, { type: "Z" as const }];
  };
  const donut = (to = .69) => vector({ schema: "editkin.motion-vector-stroke/v1", kind: "stroke", heightPixels: 80, revealFrames: 10,
    commands: circle(40, 40, 30), widthPixels: 8, to, tipRadiusPixels: 5 });

  it("draws from nothing to the requested share of its length, with a pen tip only while drawing", () => {
    const project = parseProject(createDemoProject()), graphic = donut();
    expect(motionVectorV2Schema.safeParse(graphic.vectorV2).success).toBe(true);
    assertMotionGraphicV2Contract(graphic, project.fps);
    const layout = motionGraphicV2LayoutReceipt(project, graphic);
    const at = (frame: number) => motionVectorPaths(graphic, layout, motionGraphicV2FrameReceipt(project, graphic, Math.round(graphic.timelineStart * project.fps) + frame, layout));
    expect(at(0)).toEqual([]);
    const middle = at(5), done = at(10);
    expect(middle).toHaveLength(2);
    expect(middle[1].color).toBe("#FF6B6B");
    expect(done).toHaveLength(1);
    // The finished arc is a band around the ring (half width 4) and is shorter than the closed full ring.
    const band = done[0].svg.split("Z")[0];
    const points = [...band.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map(match => [Number(match[1]), Number(match[2])]);
    expect(points.length).toBeGreaterThan(40);
    for (const [x, y] of points) expect(Math.abs(Math.hypot(x - 40, y - 40) - 30)).toBeLessThan(4.5);
    const full = donut(1);
    const fullLayout = motionGraphicV2LayoutReceipt(project, full);
    const ring = motionVectorPaths(full, fullLayout, motionGraphicV2FrameReceipt(project, full, Math.round(full.timelineStart * project.fps) + 10, fullLayout));
    expect(done[0].svg.length).toBeLessThan(ring[0].svg.length);
  });

  it("paints over glyphs when stacked over_text and rejects an empty or reversed range", () => {
    const project = parseProject(createDemoProject()), graphic = donut();
    graphic.vectorV2 = { ...(graphic.vectorV2 as Extract<NonNullable<MotionGraphic["vectorV2"]>, { kind: "stroke" }>), stack: "over_text" };
    project.motionGraphics = [graphic];
    expect(events(writeAssContent(project, project.captionStyle)).every(line => line.startsWith("Dialogue: 3,"))).toBe(true);
    const reversed = donut(.69);
    reversed.vectorV2 = { ...(reversed.vectorV2 as Extract<NonNullable<MotionGraphic["vectorV2"]>, { kind: "stroke" }>), from: .7 };
    expect(() => assertMotionGraphicV2Contract(reversed, 30)).toThrow(/from/);
    const background = donut();
    background.compositeLayer = "background";
    expect(() => assertMotionGraphicV2Contract(background, 30)).toThrow(/under_media/);
  });
});
