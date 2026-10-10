import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import type { EditProject, MotionGraphic } from "../domain/types";
import type { MotionScene2D } from "../domain/motionScene2d";
import type { SpringTargetTrack } from "../domain/motionContinuity";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import type { MotionFontSelection } from "../typography/motionFontReadiness";
import type { MotionFontConsumerReadiness } from "./useMotionFontReadiness";
import { writeAssContent } from "../render/captionAss";

const adapter = vi.hoisted(() => ({ run: undefined as PreparedGlyphRun | undefined,
  status: "pending" as MotionFontConsumerReadiness["status"] }));
vi.mock("./useMotionFontReadiness", () => ({ useMotionFontReadiness: (selection: MotionFontSelection) => ({
  selectionKey: selection.selectionKey, status: adapter.status, face: selection.face,
  ...(adapter.run ? { glyphRun: adapter.run } : {}), ...(adapter.status === "ready" ? {} : { reason: "controlled unready font" }),
}) }));
import MotionOverlay from "./MotionOverlay";

let run: PreparedGlyphRun;
beforeAll(async () => {
  const spec = bundledFontFaceSpec("EditkinFace-bebas-neue-400");
  run = await prepareGlyphRun(spec.faceId, "AV", new Uint8Array(await readFile(resolve("public/fonts", spec.fontFile))));
});
beforeEach(() => { adapter.run = run; adapter.status = "ready"; });
function constant(value: number): SpringTargetTrack {
  return { fps: 30, initialPosition: value, initialVelocity: 0, initialTarget: value,
    spring: { stiffness: 100, damping: 20, mass: 1 }, events: [] };
}
function graphic(kind: "text" | "vector"): MotionGraphic {
  const g = createMotionGraphic(kind, kind === "text" ? "title" : "card", kind === "text" ? "AV" : "", 0, 2,
    undefined, findMotionGraphicPreset(kind === "text" ? "v2-word-cascade" : "reel_native_disc").seed);
  g.x = kind === "text" ? .15 : .35; g.y = kind === "text" ? .15 : .25; g.width = kind === "text" ? .7 : .2;
  g.fontFamily = "Bebas Neue"; g.fontWeight = 400; g.fontSize = 40; g.letterSpacing = 0;
  g.outlineWidth = 2; g.shadowDepth = 2.75; g.backgroundColor = "#17202C"; g.accentColor = "#123456";
  g.layoutV2 = { ...g.layoutV2!, widthMode: "fit_content", minFontSize: 40, maxLines: 1, align: "left" };
  g.motionV2 = { sequence: { unit: kind === "text" ? "character" : "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
    entrance: { durationFrames: 12, offsetXPixels: 3.125, offsetYPixels: 4.25, scale: .73123, opacity: .4, easing: { type: "linear" } },
    exit: { durationFrames: 4, offsetXPixels: 0, offsetYPixels: -2.25, scale: .98765, opacity: 0, easing: { type: "linear" } } };
  if (g.vectorV2) { g.vectorV2.heightPixels = 24; g.vectorV2.revealFrames = 1; }
  return g;
}
function fixture(kind: "text" | "vector" = "text") {
  const p = createEmptyProject("Original source SVG camera; no mounted/pixel/playback proof", { width: 320, height: 180, fps: 30 }), g = graphic(kind);
  p.motionGraphics = [g];
  p.captions = [{ id: "source-cue", start: .5, duration: .5, text: "Focus AV" }];
  const scene: MotionScene2D = { schema: "editkin.motion-scene-2d/v1", id: "source-focus", startFrame: 0, durationFrames: 60, fps: 30,
    graphicIds: [g.id], camera: { centerX: constant(100), centerY: constant(60), zoom: constant(1.25) },
    safeArea: { left: 8, right: 8, top: 8, bottom: 8 }, semanticCues: [{ id: "cue", frame: 15, purpose: "Original source caption focus",
      graphicIds: [g.id], evidenceRefs: ["caption:source-cue"] }] };
  p.motionScenes = [scene];
  const layout = kind === "text" ? motionGraphicV2PhysicalLayoutReceipt(p, g, run) : motionGraphicV2LayoutReceipt(p, g);
  return { p, g, scene, layout };
}
function markup(project: EditProject, frame = 6) {
  return renderToStaticMarkup(<MotionOverlay project={project} playhead={frame / project.fps} trackingSelectionEnabled={false} />);
}
function cssOrigin(html: string, width: number, height: number) {
  const x = /left:([^%;"]+)%/.exec(html), y = /top:([^%;"]+)%/.exec(html);
  if (!x || !y) throw new Error("Actual projected layout origin required");
  return { x: Number(x[1]) * width / 100, y: Number(y[1]) * height / 100 };
}

describe("actual SVG scene2d projection (real glyphs, controlled readiness; no mounted/pixel proof)", () => {
  it("projects physical outer bounds while retaining the original viewBox and exact local contours", () => {
    const { p, g, layout } = fixture(), html = markup(p), frame = motionGraphicV2FrameReceipt(p, g, 6, layout);
    expect(html).toContain('data-motion-scene="source-focus"');
    expect(html).toContain(`left:${(layout.box.x * 1.25 + 35) / p.width * 100}%`);
    expect(html).toContain(`top:${(layout.box.y * 1.25 + 15) / p.height * 100}%`);
    expect(html).toContain(`width:${layout.box.width * 1.25 / p.width * 100}%`);
    expect(html).toContain(`height:${layout.box.height * 1.25 / p.height * 100}%`);
    expect(html).toContain(`viewBox="0 0 ${layout.box.width} ${layout.box.height}"`);
    frame.segments.forEach((state, index) => {
      const segment = layout.segments[index];
      expect(html).toContain(`d="${segment.outline!.svg}"`);
      expect(html).toContain(`transform="translate(${segment.x - layout.box.x + state.translateXPixels} ${segment.y - layout.box.y + state.translateYPixels}) scale(${state.scale})"`);
    });
    expect(html).not.toContain("font-family:"); expect(html).not.toContain("<span style=");
  });

  it("projects native vector viewport bounds and preserves its same-frame local state/path", () => {
    const { p, g, layout } = fixture("vector"), frame = motionGraphicV2FrameReceipt(p, g, 6, layout), html = markup(p), state = frame.vectorState!;
    expect(html).toContain('data-testid="motion-vector-v2"');
    const origin = cssOrigin(html, p.width, p.height);
    expect(origin.x).toBeCloseTo(layout.box.x * 1.25 + 35, 8);
    expect(origin.y).toBeCloseTo(layout.box.y * 1.25 + 15, 8);
    expect(html).toContain(`width:${layout.box.width * 1.25 / p.width * 100}%`);
    expect(html).toContain(`transform="translate(${state.translateXPixels} ${state.translateYPixels}) scale(${state.scale})"`);
    for (const path of motionVectorPaths(g, layout, frame)) expect(html).toContain(`d="${path.svg}"`);
  });

  it("connects actual SVG origin/local scale/shadow to the actual ASS consumer projection", () => {
    const { p, g, layout } = fixture(), html = markup(p), frame = motionGraphicV2FrameReceipt(p, g, 6, layout), origin = cssOrigin(html, p.width, p.height);
    const ass = writeAssContent(p, p.captionStyle, { physicalLayouts: new Map([[g.id, layout]]), requirePhysicalGlyphs: true });
    const events = ass.split("\n").filter(line => line.startsWith("Dialogue: 2,0:00:00.20,"));
    expect(events).toHaveLength(layout.segments.length * 2);
    expect(html).toContain('transform="translate(2.75 2.75)"');
    frame.segments.forEach((state, index) => {
      const segment = layout.segments[index], shadow = /\\pos\(([^,]+),([^)]+)\)/.exec(events[index * 2])!, primary = /\\pos\(([^,]+),([^)]+)\)/.exec(events[index * 2 + 1])!;
      // The viewBox-to-projected viewport ratio is 1.25 on both axes.
      expect(Number(primary[1])).toBeCloseTo(origin.x + 1.25 * (segment.x - layout.box.x + state.translateXPixels), 5);
      expect(Number(primary[2])).toBeCloseTo(origin.y + 1.25 * (segment.y - layout.box.y + state.translateYPixels), 5);
      expect(Number(shadow[1]) - Number(primary[1])).toBeCloseTo(2.75 * state.scale * 1.25, 5);
      expect(Number(shadow[2]) - Number(primary[2])).toBeCloseTo(2.75 * state.scale * 1.25, 5);
    });
  });

  it("keeps nonmonotonic source seeks and schema9 JSON reopen deterministic", () => {
    const { p, scene } = fixture(); scene.camera.centerX.events = [{ frame: 15, target: 112 }];
    scene.camera.zoom.events = [{ frame: 15, target: 1.3 }];
    const before = JSON.stringify(p), first = markup(p, 6);
    expect(markup(p, 21)).not.toBe(first); expect(markup(p, 6)).toBe(first);
    expect(markup(JSON.parse(before) as EditProject, 6)).toBe(first);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("blocks unready scene text and scoped v1, while preserving no-scene markup", () => {
    const { p } = fixture(); adapter.status = "pending";
    expect(markup(p)).toContain('data-testid="motion-font-blocked"');
    expect(markup(p)).not.toContain('data-testid="motion-glyph-outlines"');
    p.motionGraphics = [createMotionGraphic("text", "title", "AV", 0, 2, undefined, legacyMotionGraphicSeed("title"))];
    expect(markup(p)).toContain('data-testid="motion-scene-blocked"');
    const ordinary = fixture("vector").p; delete ordinary.motionScenes;
    expect(markup({ ...ordinary, motionScenes: [] })).toBe(markup(ordinary));
  });

  it("blocks actual current projected ink outside the scene safe area without an estimated fallback", () => {
    const { p, scene } = fixture();
    scene.camera.centerX.initialPosition = 1000; scene.camera.centerX.initialTarget = 1000;
    const html = markup(p);
    expect(html).toContain('data-testid="motion-font-blocked"');
    expect(html).toContain("safe-area");
    expect(html).not.toContain('data-testid="motion-glyph-outlines"');
  });
});
