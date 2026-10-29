import { describe, expect, it } from "vitest";
import type { Mesh3dScene } from "./mesh3dScene";
import { Mesh3dGeometryCache } from "./mesh3dGeometry";
import { renderMesh3dFrame } from "./mesh3dRasterizer";
import { renderMesh3dProjectFrameV1, resizeMeshOverlayV1 } from "./mesh3dProjectFrameV1";

function scene(): Mesh3dScene {
  return { schema: "editkin.mesh-scene/v1", enabled: true,
    background: { color: "#FFFFFF", gridColor: "#000000", grid: false, spacing: 72 },
    light: { direction: [0, 0, 1], ambient: .5, intensity: .5 },
    segments: [0, 1].map(i => ({ id: `s${i}`, name: "shot", timelineStart: i, duration: 1,
      camera: { position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 55, near: .1, far: 30 }, cameraKeyframes: [],
      objects: [{ id: "hero", name: "hero", geometry: { kind: "box", width: 1, height: 1, depth: 1 },
        pose: { position: [i ? .8 : 0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] },
        keyframes: [], material: { color: "#203040", unlit: true } }] })) };
}
describe("shared project frame adapter", () => {
  it("keeps the legacy renderer exact when bindings are absent", () => {
    const input = scene(), cache = new Mesh3dGeometryCache();
    const old = renderMesh3dFrame(input, .5, 96, 54, cache);
    expect(renderMesh3dProjectFrameV1(input, { timelineFrame: 15, fps: 30 }, 96, 54, cache)).toEqual(old);
    expect(old.depthPrecise).toBeUndefined();
  });
  it("avoids dark fringes at a transparent red edge", () => {
    const resized = resizeMeshOverlayV1({ width: 2, height: 1, rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]) }, 3, 1);
    expect([...resized.slice(4, 8)]).toEqual([255, 0, 0, 128]);
    expect([...resized.slice(8)]).toEqual([0, 0, 0, 0]);
  });
  it("switches active bindings at the exact cut without leaking the previous scene", () => {
    const input = scene();
    input.overlaysV1 = { schema: "editkin.mesh-overlays/v1",
      anchors: input.segments.map(s => ({ id: s.id, segmentId: s.id, objectId: "hero", localPoint: [0, 0, .5] })),
      layers: input.segments.map(s => ({ id: s.id, anchorId: s.id, clipId: s.id, size: [.2, .2], offset: [0, 0], pivot: [.5, .5], opacity: 1, occlusion: "always_front" })) };
    const texture = { width: 1, height: 1, rgba: new Uint8Array([0, 255, 0, 255]) };
    const atCut = renderMesh3dProjectFrameV1(input, { timelineFrame: 30, fps: 30 }, 96, 54, new Mesh3dGeometryCache(), new Map([["s1", texture]]));
    expect([...atCut.rgba.slice((27 * 96 + 60) * 4, (27 * 96 + 60) * 4 + 4)]).toEqual([0, 255, 0, 255]);
    expect(() => renderMesh3dProjectFrameV1(input, { timelineFrame: 29, fps: 30 }, 96, 54, new Mesh3dGeometryCache(), new Map([["s1", texture]]))).toThrow("SOURCE_MISSING");
  });
  it("rejects oversized allocations and malformed source buffers", () => {
    expect(() => resizeMeshOverlayV1({ width: 2, height: 1, rgba: new Uint8Array(4) }, 2, 1)).toThrow("INVALID");
    expect(() => resizeMeshOverlayV1({ width: 1, height: 1, rgba: new Uint8Array(4) }, 10000, 10000)).toThrow("BUDGET");
  });
});
