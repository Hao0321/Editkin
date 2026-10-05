import { describe, expect, it } from "vitest";
import type { MotionGraphic } from "../domain/types";
import { createEmptyProject } from "../domain/editGraph";
import { parseProject } from "../application/projectFiles";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "./compositionV2";
import { springGeometryPaths } from "./springGeometryPaths";
import { motionVectorPaths } from "./vectorGeometry";
import type { SpringGeometryTrack } from "./springGeometryTrack";
import type { SpringTargetTrack } from "./springTargetTrack";

const property = (initialPosition: number, target = initialPosition, frame = 15): SpringTargetTrack => ({
  fps: 30, initialPosition, initialVelocity: 0, initialTarget: initialPosition,
  spring: { stiffness: 100, damping: 20, mass: 1 }, events: initialPosition === target ? [] : [{ frame, target }],
});
const coordinates = (path: string): number[] => (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const bounds = (path: string) => {
  const numbers = coordinates(path), x = numbers.filter((_, index) => index % 2 === 0), y = numbers.filter((_, index) => index % 2 === 1);
  return { left: Math.min(...x), top: Math.min(...y), right: Math.max(...x), bottom: Math.max(...y) };
};

function fixture() {
  const project = createEmptyProject("Original spring panel", { width: 600, height: 400, fps: 30 });
  const geometry: SpringGeometryTrack = { localId: "circle-to-card", envelope: { x: 0, y: 0, width: 300, height: 200 },
    left: property(30, 20), right: property(90, 240, 18), top: property(40, 30), bottom: property(100, 160), cornerRadius: property(30, 10) };
  const phase = { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" as const } };
  const graphic: MotionGraphic = { schema: "hao.motion-composition/v2", id: geometry.localId, name: "Original circle to card", kind: "card", text: "",
    timelineStart: .5, duration: 3, x: .2, y: .2, width: .5, fontSize: 8, textColor: "#FFFFFF", backgroundColor: "#175CD3", accentColor: "#091C2F",
    outlineWidth: 0, animation: "fade", offsetX: 0, offsetY: 0, compositeLayer: "foreground",
    vectorV2: { schema: "editkin.motion-vector-continuity/v1", kind: "spring_panel", heightPixels: 200, revealFrames: 1, geometry },
    motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 }, entrance: phase, exit: { ...phase } },
    layoutV2: { safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" } };
  project.motionGraphics.push(graphic);
  const layout = motionGraphicV2LayoutReceipt(project, graphic);
  const frame = (localFrame: number) => motionGraphicV2FrameReceipt(project, graphic, 15 + localFrame, layout);
  return { project, graphic, layout, frame, geometry };
}

describe("shared original spring panel paths", () => {
  it("renders a circle then a card in fixed local pixel coordinates through the actual vector route", () => {
    const { graphic, layout, frame } = fixture();
    const circle = motionVectorPaths(graphic, layout, frame(0));
    expect(circle).toHaveLength(1);
    expect(circle[0].color).toBe(graphic.backgroundColor);
    expect(circle[0].svg.startsWith("M 60 40")).toBe(true);
    expect(bounds(circle[0].svg)).toEqual({ left: 30, top: 40, right: 90, bottom: 100 });
    expect((circle[0].svg.match(/C /g) ?? []).length).toBe(4);
    const middle = bounds(motionVectorPaths(graphic, layout, frame(24))[0].svg);
    expect(middle.right - middle.left).toBeGreaterThan(60);
    expect(middle.bottom - middle.top).toBeGreaterThan(60);
    const card = bounds(motionVectorPaths(graphic, layout, frame(84))[0].svg);
    expect(card.left).toBeCloseTo(20, 2);
    expect(card.right).toBeCloseTo(240, 2);
    expect(card.top).toBeCloseTo(30, 2);
    expect(card.bottom).toBeCloseTo(160, 2);
    expect(layout.box).toEqual({ x: 120, y: 80, width: 300, height: 200 });
  });

  it("retains independent leading/trailing edges instead of scaling a baked picture", () => {
    const { graphic, layout, frame } = fixture();
    const sample = bounds(motionVectorPaths(graphic, layout, frame(17))[0].svg);
    expect(sample.left).toBeLessThan(30);
    expect(sample.right).toBe(90);
  });

  it("keeps identical authored coordinates in SVG and ASS fill and inside stroke", () => {
    const { graphic, layout, frame } = fixture();
    graphic.outlineWidth = 2.5;
    for (const localFrame of [0, 17, 24, 60, 84]) {
      const paths = motionVectorPaths(graphic, layout, frame(localFrame));
      expect(paths.map(path => path.color)).toEqual([graphic.backgroundColor, graphic.accentColor]);
      for (const path of paths) {
        expect(coordinates(path.svg)).toEqual(coordinates(path.ass));
        expect(path.svg.replace(/ Z/g, "").replace(/C/g, "b").replace(/M/g, "m").replace(/L/g, "l")).toBe(path.ass);
        const extent = bounds(path.svg);
        expect(extent.left).toBeGreaterThanOrEqual(0);
        expect(extent.top).toBeGreaterThanOrEqual(0);
        expect(extent.right).toBeLessThanOrEqual(layout.box.width);
        expect(extent.bottom).toBeLessThanOrEqual(layout.box.height);
      }
    }
  });

  it("generates exactly the same paths after nonmonotonic seek", () => {
    const { graphic, layout, frame } = fixture(), localFrames = [0, 17, 24, 60, 84];
    const forward = new Map(localFrames.map(local => [local, motionVectorPaths(graphic, layout, frame(local))]));
    for (const local of [60, 0, 84, 17, 24, 60]) expect(motionVectorPaths(graphic, layout, frame(local))).toEqual(forward.get(local));
  });

  it("reuses the same receipt and paths after save/reopen reorders nested geometry keys", () => {
    const { project, graphic, layout, frame } = fixture();
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
      return value;
    };
    const serialized = JSON.stringify(reverseKeys(project));
    expect(serialized).not.toBe(JSON.stringify(project));
    const reopened = parseProject(JSON.parse(serialized)), current = reopened.motionGraphics[0];
    const currentLayout = motionGraphicV2LayoutReceipt(reopened, current);
    expect(currentLayout).toEqual(layout);
    const originalFrame = frame(24);
    const reopenedFrame = motionGraphicV2FrameReceipt(reopened, current, originalFrame.timelineFrame, layout);
    expect(reopenedFrame).toEqual(originalFrame);
    expect(motionVectorPaths(current, layout, reopenedFrame)).toEqual(motionVectorPaths(graphic, layout, originalFrame));
  });

  it("rejects foreign local identity, envelope or receipt instead of drawing stale geometry", () => {
    const { graphic, layout, frame, geometry } = fixture();
    const validFrame = frame(24);
    geometry.localId = "foreign";
    expect(() => springGeometryPaths(graphic, layout, validFrame)).toThrow(/identity/);
    geometry.localId = graphic.id;
    geometry.envelope.width = 301;
    expect(() => springGeometryPaths(graphic, layout, validFrame)).toThrow(/envelope/);
    geometry.envelope.width = 300;
    geometry.envelope.x = 1;
    expect(() => springGeometryPaths(graphic, layout, validFrame)).toThrow(/envelope/);
    geometry.envelope.x = 0;
    expect(() => springGeometryPaths(graphic, { ...layout, graphicId: "foreign" }, validFrame)).toThrow(/identity/);
    expect(() => springGeometryPaths(graphic, layout, { ...validFrame, graphicId: "foreign" })).toThrow(/identity/);
    expect(() => springGeometryPaths(graphic, layout, { ...validFrame, layoutReceiptId: "foreign" })).toThrow(/identity/);
    expect(() => springGeometryPaths(graphic, layout, { ...validFrame, timelineFrame: validFrame.timelineFrame + 1 })).toThrow(/local frame/);
  });

  it("rejects the old marker and background composition", () => {
    const { graphic, layout, frame } = fixture(), validFrame = frame(0);
    expect(() => springGeometryPaths({ ...graphic, compositeLayer: "background" }, layout, validFrame)).toThrow(/foreground/);
    const legacy = structuredClone(graphic);
    legacy.vectorV2!.schema = "editkin.motion-vector/v1";
    expect(() => springGeometryPaths(legacy, layout, validFrame)).toThrow(/versioned/);
  });

  it("rejects unsafe outline and radius before compatibility panel clamps can hide them", () => {
    const { graphic, layout, frame, geometry } = fixture(), validFrame = frame(0);
    for (const outlineWidth of [-1, 31, NaN, Infinity]) expect(() => springGeometryPaths({ ...graphic, outlineWidth }, layout, validFrame)).toThrow(/outline/);
    geometry.cornerRadius = property(31);
    expect(() => springGeometryPaths(graphic, layout, validFrame)).toThrow(/radius/);
  });

  it("rejects a spring edge overshooting the admitted fixed canvas", () => {
    const { graphic, layout, frame, geometry } = fixture(), validFrame = frame(10);
    geometry.right = { ...property(90, 260, 0), spring: { stiffness: 100, damping: 0, mass: 1 } };
    expect(() => springGeometryPaths(graphic, layout, validFrame)).toThrow(/envelope/);
  });
});
