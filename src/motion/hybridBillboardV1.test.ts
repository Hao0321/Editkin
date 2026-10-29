import { describe, expect, it } from "vitest";
import { Mesh3dGeometryCache } from "./mesh3dGeometry";
import { renderMesh3dAnchorFrameV1 } from "./mesh3dAnchorV1";
import { compositeHybridBillboardsV1, type HybridBillboardV1 } from "./hybridBillboardV1";
import type { Mesh3dScene } from "./mesh3dScene";

function scene(): Mesh3dScene { return { schema: "editkin.mesh-scene/v1", enabled: true,
  background: { color: "#FFFFFF", gridColor: "#000000", grid: false, spacing: 72 }, light: { direction: [0, 0, 1], ambient: .5, intensity: .5 },
  segments: [{ id: "shot", name: "shot", timelineStart: 0, duration: 2, camera: { position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 55, near: .1, far: 30 }, cameraKeyframes: [],
    objects: [{ id: "hero", name: "hero", geometry: { kind: "box", width: 1, height: 1, depth: 1 },
      pose: { position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] }, keyframes: [], material: { color: "#203040", unlit: true } }] }] }; }
const render = (input = scene(), timelineFrame = 0) => renderMesh3dAnchorFrameV1(input, { timelineFrame, fps: 60 }, 96, 54,
  new Mesh3dGeometryCache(), [{ id: "label", objectId: "hero", segmentId: "shot", localPoint: [0, 0, .5] }]);
function layer(patch: Partial<HybridBillboardV1> = {}): HybridBillboardV1 {
  const rgba = new Uint8Array(16 * 8 * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([0, 255, 0, 255], i);
  return { anchorId: "label", rgba, width: 16, height: 8, opacity: 1, pivot: [.5, .5], offsetPixels: [0, 0], occlusion: "depth_test", ...patch };
}
const rgb = (data: Uint8ClampedArray, x: number, y: number) => Array.from(data.slice((y * 96 + x) * 4, (y * 96 + x) * 4 + 3));

describe("2D billboard attached to real 3D source pixels", () => {
  it("keeps a distant foreground over the billboard even at a small near plane", () => {
    const input = scene(), segment = input.segments[0], front = structuredClone(segment.objects[0]);
    segment.camera = { ...segment.camera, position: [0, 0, 100], near: .01, far: 200 };
    segment.objects[0].geometry = { kind: "box", width: 10, height: 10, depth: 1 };
    front.id = "front"; front.geometry = { kind: "box", width: 10, height: 10, depth: .2 };
    front.pose.position = [0, 0, 1.5]; front.material.color = "#0000FF"; segment.objects.push(front);
    const output = compositeHybridBillboardsV1(render(input), [layer()]);
    expect(rgb(output.rgba, 48, 27)).toEqual([0, 0, 255]);
  });
  it("composites actual 2D pixels without modifying source color, depth or sprite buffers", () => {
    const frame = render(), sprite = layer(), before = new Uint8ClampedArray(frame.frame.rgba), depth = new Float32Array(frame.frame.depth);
    const actual = compositeHybridBillboardsV1(frame, [sprite]);
    expect(rgb(actual.rgba, 48, 27)).toEqual([0, 255, 0]);
    expect(actual.drawnPixels).toBe(128);
    expect(frame.frame.rgba).toEqual(before); expect(frame.frame.depth).toEqual(depth);
    expect(sprite.rgba.slice(0, 4)).toEqual(new Uint8Array([0, 255, 0, 255]));
    expect(compositeHybridBillboardsV1(frame, []).rgba).toEqual(before);
  });
  it("tracks actual object movement in the final pixel coordinates", () => {
    const input = scene(), hero = input.segments[0].objects[0];
    hero.keyframes = [{ time: 1, pose: { ...hero.pose, position: [1, 0, 0] }, easing: "linear" }];
    const a = render(input), b = render(input, 30);
    const outA = compositeHybridBillboardsV1(a, [layer()]), outB = compositeHybridBillboardsV1(b, [layer()]);
    const xA = Math.round(a.anchors[0].x! * 96), xB = Math.round(b.anchors[0].x! * 96);
    expect(xB).toBeGreaterThan(xA + 5);
    expect(rgb(outB.rgba, xB, 27)).toEqual([0, 255, 0]);
    expect(rgb(outA.rgba, xB + 7, 27)).not.toEqual([0, 255, 0]);
    expect(outB.timelineFrame).toBe(30);
  });
  it("uses real depth for partial foreground occlusion; always-front is a distinct deliberate choice", () => {
    const input = scene(), front = structuredClone(input.segments[0].objects[0]);
    front.id = "front"; front.geometry = { kind: "box", width: .2, height: 2, depth: .2 };
    front.pose.position = [0, 0, 1.5]; front.material.color = "#0000FF";
    input.segments[0].objects.push(front);
    const frame = render(input), actual = compositeHybridBillboardsV1(frame, [layer()]);
    expect(frame.anchors[0].visibility).toBe("occluded");
    expect(actual.drawnPixels).toBeGreaterThan(0); expect(actual.depthRejectedPixels).toBeGreaterThan(0);
    expect(rgb(actual.rgba, 48, 27)).toEqual([0, 0, 255]);
    expect(rgb(actual.rgba, 41, 27)).toEqual([0, 255, 0]);
    const control = compositeHybridBillboardsV1(frame, [layer({ occlusion: "always_front" })]);
    expect(rgb(control.rgba, 48, 27)).toEqual([0, 255, 0]);
    expect(control.depthRejectedPixels).toBe(0);
    expect(compositeHybridBillboardsV1(frame, [layer({ occlusion: "hide_with_anchor" })]).drawnPixels).toBe(0);
  });
  it("applies alpha and declared layer order rather than treating every overlay as opaque", () => {
    const frame = render(), first = layer({ opacity: .5 });
    const blended = compositeHybridBillboardsV1(frame, [first]);
    expect(rgb(blended.rgba, 48, 27)).toEqual([16, 152, 32]);
    const blue = layer(); for (let i = 0; i < blue.rgba.length; i += 4) blue.rgba.set([0, 0, 255, 255], i);
    expect(rgb(compositeHybridBillboardsV1(frame, [first, blue]).rgba, 48, 27)).toEqual([0, 0, 255]);
  });
  it("clips sprite rectangles and hides offscreen targets", () => {
    const frame = render(), clipped = layer({ offsetPixels: [-48, 0] });
    expect(compositeHybridBillboardsV1(frame, [clipped]).drawnPixels).toBe(64);
    const input = scene(); input.segments[0].objects[0].pose.position = [100, 0, 0];
    expect(compositeHybridBillboardsV1(render(input), [layer()]).drawnPixels).toBe(0);
  });
  it("rejects forged/mismatched frame handles and invalid layer data before compositing", () => {
    const frame = render();
    expect(() => compositeHybridBillboardsV1({ ...frame, timelineFrame: 1 }, [])).toThrow("FRAME_NOT_ISSUED");
    expect(() => compositeHybridBillboardsV1(frame, [layer({ anchorId: "missing" })])).toThrow("ANCHOR_MISSING");
    expect(() => compositeHybridBillboardsV1(frame, [layer({ rgba: new Uint8Array(1) })])).toThrow("LAYER_INVALID");
    expect(() => compositeHybridBillboardsV1(frame, [layer({ opacity: NaN })])).toThrow("LAYER_INVALID");
    expect(() => compositeHybridBillboardsV1(frame, Array.from({ length: 129 }, () => layer()))).toThrow("BUDGET");
  });
});
