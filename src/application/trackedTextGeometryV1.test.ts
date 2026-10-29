import { describe, expect, it } from "vitest";
import { trackedTextFixtureV1 } from "./__fixtures__/trackedTextV1.fixture";
import { trackedPhysicalTextFrameV1, trackedTextNumberV1, TRACKED_TEXT_CURVE_ERROR_PIXELS_V1 } from "./trackedTextGeometryV1";
import { assertVectorTrackingGraphicV1 } from "../domain/vectorTrackingV1";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { editorCommandSchema } from "../domain/schema";
import { dispatchCommand, createHistory, undo, redo } from "../domain/history";
import { migrateProject } from "../domain/editGraph";
import type { MotionGlyphPathCommand } from "../motion/motionGlyphPaths";

type Point = { x: number; y: number };
function first(commands: readonly MotionGlyphPathCommand[]) { const p = commands.find(p => p.type === "M"); if (p?.type !== "M") throw Error("no contour"); return p; }
function polygonDistance(p: Point, commands: readonly MotionGlyphPathCommand[]) {
  let prior: Point | undefined, start: Point | undefined, minimum = Infinity;
  const edge = (a: Point, b: Point) => { const dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy;
    const t = d ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / d)) : 0;
    minimum = Math.min(minimum, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)); };
  for (const c of commands) { if (c.type === "M") { prior = c; start = c; }
    else if (c.type === "L") { edge(prior!, c); prior = c; } else if (c.type === "Z") { edge(prior!, start!); prior = undefined; } }
  return minimum;
}
/** Independent unit-square quadrilateral formula, not the product's 8x8 solver. */
function projectQuad(q: readonly Point[], x: number, y: number): Point {
  const dx1 = q[1].x - q[2].x, dx2 = q[3].x - q[2].x, dx3 = q[0].x - q[1].x + q[2].x - q[3].x;
  const dy1 = q[1].y - q[2].y, dy2 = q[3].y - q[2].y, dy3 = q[0].y - q[1].y + q[2].y - q[3].y;
  const d = dx1 * dy2 - dx2 * dy1, g = (dx3 * dy2 - dx2 * dy3) / d, h = (dx1 * dy3 - dx3 * dy1) / d;
  return { x: ((q[1].x - q[0].x + g * q[1].x) * x + (q[3].x - q[0].x + h * q[3].x) * y + q[0].x) / (g * x + h * y + 1),
    y: ((q[1].y - q[0].y + g * q[1].y) * x + (q[3].y - q[0].y + h * q[3].y) * y + q[0].y) / (g * x + h * y + 1) };
}

describe("shared physical text tracking geometry", () => {
  it("admits explicit v2 text through the existing binding without mutating the project", async () => {
    const f = await trackedTextFixtureV1(), before = JSON.stringify(f.p);
    expect(() => assertVectorTrackingGraphicV1(f.g)).not.toThrow();
    const result = trackedPhysicalTextFrameV1(f.p, f.g, f.layout, 6, f.camera(6));
    expect(result).toMatchObject({ visible: true, trackId: "follow", mode: "anchor", fontSha256: f.layout.physicalFont!.fontSha256 });
    expect(JSON.stringify(f.p)).toBe(before); expect(result.paths.length).toBeGreaterThan(0);
  });
  it("matches an independently computed physical-pixel anchor rotation/scale/translation on every project frame", async () => {
    const f = await trackedTextFixtureV1(), segment = f.layout.segments[0], start = first(segment.outline!.commands), xs: number[] = [];
    for (let frame = 0; frame <= 12; frame++) {
      const result = trackedPhysicalTextFrameV1(f.p, f.g, f.layout, frame, f.camera(frame)), p = first(result.paths[0].commands);
      const t = frame / 12, a = 20 * t * Math.PI / 180, scale = 1 + .15 * t;
      const cx = (.3 + .1 * t) * 320, cy = (.4 + .03 * t) * 180;
      const x = segment.x + start.x - .3 * 320, y = segment.y + start.y - .4 * 180;
      expect(p.x).toBeCloseTo(cx + scale * (Math.cos(a) * x - Math.sin(a) * y), 5);
      expect(p.y).toBeCloseTo(cy + scale * (Math.sin(a) * x + Math.cos(a) * y), 5); xs.push(p.x);
    }
    expect(new Set(xs).size).toBe(13);
  });
  it("preserves cubic commands in anchor mode and canonical SVG/ASS values", async () => {
    const f = await trackedTextFixtureV1({ text: "B8" }), r = trackedPhysicalTextFrameV1(f.p, f.g, f.layout, 6, f.camera(6));
    expect(f.layout.segments[0].outline!.commands.some(c => c.type === "C")).toBe(true);
    expect(r.paths[0].commands.filter(c => c.type === "C").length).toBe(f.layout.segments[0].outline!.commands.filter(c => c.type === "C").length);
    expect(r.paths[0].svg).toContain("C "); expect(r.paths[0].ass).toContain("b ");
    expect(trackedTextNumberV1(-0)).toBe("0"); expect(trackedTextNumberV1(.000001)).toBe("0.000001");
  });
  it("matches a closed-form homography and adaptively bounds actual font cubic error", async () => {
    const f = await trackedTextFixtureV1({ text: "B8", mode: "surface" }), result = trackedPhysicalTextFrameV1(f.p, f.g, f.layout, 12, f.camera(12));
    const segment = f.layout.segments[0], source = first(segment.outline!.commands), out = result.paths[0];
    const project = (p: Point) => { const q = projectQuad(f.p.motionTracks[0].points[1].quad!, ((segment.x + p.x) / 320 - .1) / .4,
      ((segment.y + p.y) / 180 - .2) / .4); return { x: q.x * 320, y: q.y * 180 }; };
    expect(first(out.commands).x).toBeCloseTo(project(source).x, 5); expect(first(out.commands).y).toBeCloseTo(project(source).y, 5);
    expect(out.commands.some(c => c.type === "C")).toBe(false);
    let prior: Point | undefined, curves = 0;
    for (const c of segment.outline!.commands) {
      if (c.type === "Z") { prior = undefined; continue; }
      if (c.type === "C") { const a = prior!; curves++;
        for (let k = 0; k <= 20; k++) { const t = k / 20, u = 1 - t;
          const p = project({ x: u ** 3 * a.x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x,
            y: u ** 3 * a.y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y });
          expect(polygonDistance(p, out.commands)).toBeLessThanOrEqual(TRACKED_TEXT_CURVE_ERROR_PIXELS_V1 + .000002);
        }
      } prior = c;
    }
    expect(curves).toBeGreaterThan(3);
    const shifted = { ...first(out.commands), x: first(out.commands).x + 2 };
    expect(Math.hypot(shifted.x - project(source).x, shifted.y - project(source).y)).toBeGreaterThan(1.99);
  });
  it("hides exactly at an explicitly lost sample, without drawing a stale label", async () => {
    const f = await trackedTextFixtureV1();
    expect(trackedPhysicalTextFrameV1(f.p, f.g, f.layout, 17, f.camera(17)).visible).toBe(true);
    for (const frame of [18, 19, 23]) expect(trackedPhysicalTextFrameV1(f.p, f.g, f.layout, frame, f.camera(frame))).toMatchObject({ visible: false, paths: [] });
  });
  it("uses actual glyph layout even on hidden frames; estimated or stale receipts never downgrade", async () => {
    const f = await trackedTextFixtureV1(), estimated = motionGraphicV2LayoutReceipt(f.p, f.g);
    expect(() => trackedPhysicalTextFrameV1(f.p, f.g, estimated, 18, f.camera(18))).toThrow("PHYSICAL_LAYOUT_REQUIRED");
    f.g.text = "different";
    expect(() => trackedPhysicalTextFrameV1(f.p, f.g, f.layout, 6, f.camera(6))).toThrow();
  });
  it("tracks panel, border, shadow and independently animated glyph segments together", async () => {
    const f = await trackedTextFixtureV1({ text: "AV", edit: (_p, g) => {
      g.backgroundColor = "#123456DD"; g.outlineWidth = 2; g.shadowDepth = 2; g.shadowBlurPixels = 1.5;
      g.motionV2!.sequence.unit = "character"; g.motionV2!.entrance = { ...g.motionV2!.entrance, durationFrames: 8, rotationDegrees: -10, blurPixels: 2, scale: .8, offsetYPixels: 8 };
    } });
    const r = trackedPhysicalTextFrameV1(f.p, f.g, f.layout, 4, f.camera(4));
    expect(r.paths.map(p => p.slot)).toEqual([0, 1, 2, 3, 4, 5]); expect(r.paths[2].blurPixels).toBeGreaterThan(r.paths[3].blurPixels);
    expect(new Set(r.paths.map(p => p.slot)).size).toBe(r.paths.length);
    expect(motionGraphicV2FrameReceipt(f.p, f.g, 4, f.layout).segments[0].rotationDegrees).not.toBe(0);
  });
  it.each(["legacy", "paint", "window", "hold", "offset", "background", "vector"])("rejects incompatible %s binding before rendering", async kind => {
    const f = await trackedTextFixtureV1();
    if (kind === "legacy") f.g.trackId = "follow";
    if (kind === "paint") f.g.visualStyle = "native_paint";
    if (kind === "window") f.g.clipRegion = { x: 0, y: 0, width: 1, height: 1 };
    if (kind === "hold") f.g.holdBeatV3 = {} as never;
    if (kind === "offset") f.g.offsetX = .1;
    if (kind === "background") f.g.compositeLayer = "background";
    if (kind === "vector") f.g.vectorV2 = { kind: "shape" } as never;
    expect(() => trackedPhysicalTextFrameV1(f.p, f.g, f.layout, 6, f.camera(6))).toThrow();
  });
  it("persists the existing field and applies/reverts binding with one existing command", async () => {
    const f = await trackedTextFixtureV1(), binding = { ...f.g.vectorTrackingV1! }; delete f.g.vectorTrackingV1;
    const before = structuredClone(f.p), command = editorCommandSchema.parse({ type: "update_motion_graphic", graphicId: f.g.id, patch: { vectorTrackingV1: binding } });
    const h = dispatchCommand(createHistory(f.p), command), reopened = migrateProject(JSON.parse(JSON.stringify(h.present)));
    expect(reopened.motionGraphics[0].vectorTrackingV1).toEqual(binding); expect(h.past).toHaveLength(1);
    expect(undo(h).present).toEqual(before); expect(redo(undo(h)).present).toEqual(h.present);
  });
  it("refuses nonfinite frame/coordinate values and missing track/reference geometry", async () => {
    const f = await trackedTextFixtureV1(); expect(() => trackedTextNumberV1(NaN)).toThrow("COORDINATE");
    expect(() => trackedTextNumberV1(32769)).toThrow("COORDINATE");
    expect(() => trackedPhysicalTextFrameV1(f.p, f.g, f.layout, NaN, f.camera(0))).toThrow("PHYSICAL");
    f.p.motionTracks[0].id = "different"; expect(() => trackedPhysicalTextFrameV1(f.p, f.g, f.layout, 6, f.camera(6))).toThrow("MISSING_OR_AMBIGUOUS");
  });
});
