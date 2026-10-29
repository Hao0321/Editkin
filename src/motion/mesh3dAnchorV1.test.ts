import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Mesh3dGeometryCache, mesh3dSceneTextFaceIdsV1, parseMesh3dFont } from "./mesh3dGeometry";
import { renderMesh3dAnchorFrameV1, type Mesh3dWorldAnchorV1 } from "./mesh3dAnchorV1";
import { mesh3dCameraAt, type Mesh3dObject, type Mesh3dScene } from "./mesh3dScene";
import { mesh3dProjection } from "./mesh3dRasterizer";
import { mesh3dRayDepthV1 } from "./mesh3dRayDepthV1";

function object(id = "hero"): Mesh3dObject { return { id, name: id, geometry: { kind: "box", width: 1, height: 1, depth: 1 },
  pose: { position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] }, keyframes: [], material: { color: "#203040", unlit: true } }; }
function scene(): Mesh3dScene { return { schema: "editkin.mesh-scene/v1", enabled: true,
  background: { color: "#FFFFFF", gridColor: "#000000", grid: false, spacing: 72 }, light: { direction: [0, 0, 1], ambient: .5, intensity: .5 },
  segments: [{ id: "shot", name: "shot", timelineStart: 0, duration: 2, camera: { position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 55, near: .1, far: 30 },
    cameraKeyframes: [], objects: [object()] }] }; }
const binding = (): Mesh3dWorldAnchorV1 => ({ id: "label", segmentId: "shot", objectId: "hero", localPoint: [0, 0, .5] });
const render = (input = scene(), anchors = [binding()], timelineFrame = 0) => renderMesh3dAnchorFrameV1(input, { timelineFrame, fps: 60 }, 96, 54, new Mesh3dGeometryCache(), anchors);

describe("world anchors use actual mesh camera/pose and z-buffer", () => {
  it("permits a fully authored rotation rather than limiting degrees with the position range", () => {
    const input = scene(); input.segments[0].objects[0].pose.rotationDegrees = [0, 360, 0];
    expect(() => render(input)).not.toThrow();
  });
  it("rejects sparse local coordinates rather than treating holes as a zero point", () => {
    const anchor = binding(); anchor.localPoint = new Array(3) as [number, number, number];
    expect(() => render(scene(), [anchor])).toThrow("BINDING_INVALID");
  });
  it("does not let a fixed normalized-depth bias reveal anchors behind a distant foreground", () => {
    const input = scene(), segment = input.segments[0], foreground = object("front");
    segment.camera = { ...segment.camera, position: [0, 0, 100], near: .01, far: 200 };
    segment.objects[0].geometry = { kind: "box", width: 10, height: 10, depth: 1 };
    foreground.geometry = { kind: "box", width: 10, height: 10, depth: .2 };
    foreground.pose.position = [0, 0, 1.5]; segment.objects.push(foreground);
    expect(render(input).anchors[0].visibility).toBe("occluded");
  });
  it("does not falsely self-occlude front-surface anchors on a slanted face", () => {
    const input = scene(); input.segments[0].objects[0].pose.rotationDegrees = [0, 45, 0];
    const anchors = Array.from({ length: 16 }, (_, i) => ({ ...binding(), id: `a${i}`, localPoint: [-.4 + i * .8 / 15, 0, .5] as [number, number, number] }));
    expect(render(input, anchors).anchors.map(a => a.visibility)).toEqual(Array(16).fill("visible"));
  });
  it("projects a real front-surface anchor and reports its physical depth", () => {
    const result = render();
    expect(result.anchors[0]).toMatchObject({ x: .5, y: .5, visibility: "visible" });
    expect(result.anchors[0].depthNdc).toBeCloseTo(result.frame.depth[27 * 96 + 48], 6);
  });
  it("matches an analytical perspective after scale, rotation and translation", () => {
    const input = scene(), hero = input.segments[0].objects[0];
    hero.pose = { position: [.3, .2, 0], rotationDegrees: [0, 0, 90], scale: [2, 1, 1] };
    const anchor = binding(); anchor.localPoint = [.2, 0, .5];
    const actual = render(input, [anchor]).anchors[0], tangent = Math.tan(55 * Math.PI / 360);
    expect(actual.x).toBeCloseTo(.5 + .3 / (2 * 3.5 * tangent * (96 / 54)), 10);
    expect(actual.y).toBeCloseTo(.5 - .6 / (2 * 3.5 * tangent), 10);
  });
  it("uses the same frame clock for camera movement and moving object keyframes", () => {
    const input = scene(), segment = input.segments[0], hero = segment.objects[0];
    hero.keyframes = [{ time: 1, pose: { ...hero.pose, position: [1, 0, 0] }, easing: "linear" }];
    segment.cameraKeyframes = [{ time: 1, camera: { ...segment.camera, position: [0, 0, 6] }, easing: "linear" }];
    const result = render(input, [binding()], 30), tangent = Math.tan(55 * Math.PI / 360);
    expect(result.timelineFrame).toBe(30);
    expect(result.anchors[0].x).toBeCloseTo(.5 + .5 / (2 * 4.5 * tangent * (96 / 54)), 10);
  });
  it("detects self-occlusion and real foreground occlusion", () => {
    const internal = binding(); internal.localPoint = [0, 0, 0];
    expect(render(scene(), [internal]).anchors[0].visibility).toBe("occluded");
    const input = scene(), foreground = object("front"); foreground.pose.position = [0, 0, 1.5];
    input.segments[0].objects.push(foreground);
    expect(render(input).anchors[0].visibility).toBe("occluded");
    expect(render().anchors[0].visibility).toBe("visible");
  });
  it("hides behind-camera, clipped and offscreen anchors instead of clamping them", () => {
    for (const [position, expected] of [[[100, 0, 0], "outside_frustum"], [[0, 0, 6], "behind_camera"]] as const) {
      const input = scene(); input.segments[0].objects[0].pose.position = [...position];
      expect(render(input).anchors[0]).toMatchObject({ visibility: expected, x: null, y: null });
    }
    const near = binding(); near.localPoint = [0, 0, 3.95];
    expect(render(scene(), [near]).anchors[0].visibility).toBe("outside_frustum");
  });
  it("respects exclusive segment ends and inactive bindings", () => {
    const input = scene(), next = structuredClone(input.segments[0]); next.id = "next"; next.timelineStart = 2;
    input.segments.push(next);
    const second = { ...binding(), id: "second", segmentId: "next" };
    const frame = render(input, [binding(), second], 120);
    expect(frame.segmentId).toBe("next");
    expect(frame.anchors.map(a => a.visibility)).toEqual(["inactive", "visible"]);
    expect(() => render(scene(), [binding()], 120)).toThrow("NO_UNIQUE_ACTIVE");
    input.segments[1].timelineStart = 1;
    expect(() => render(input, [binding()], 90)).toThrow("NO_UNIQUE_ACTIVE");
  });
  describe("blended draws are not solid occluders (mesh3dDrawBlendedV1)", () => {
    const FONT_ROOT = join(import.meta.dirname, "../../public/fonts/render");
    const facesFor = (input: Mesh3dScene) => new Map(mesh3dSceneTextFaceIdsV1(input).map(id => {
      const bytes = readFileSync(join(FONT_ROOT, `${id}.ttf`)); return [id, parseMesh3dFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))] as const;
    }));
    // A small target box at the origin; the anchor on its front face sits behind a foreground object at z = 1.5.
    function behind(foreground: Pick<Mesh3dObject, "geometry"> & { material?: Partial<Mesh3dObject["material"]>; position?: [number, number, number] }) {
      const input = scene(), segment = input.segments[0], front = object("front");
      segment.objects[0].geometry = { kind: "box", width: .4, height: .4, depth: .4 };
      front.geometry = foreground.geometry; front.material = { ...front.material, ...foreground.material }; front.pose.position = foreground.position ?? [0, 0, 1.5];
      segment.objects.push(front);
      const cache = new Mesh3dGeometryCache(new Map(), facesFor(input)), anchor = { ...binding(), localPoint: [0, 0, .2] as [number, number, number] };
      const frame = renderMesh3dAnchorFrameV1(input, { timelineFrame: 0, fps: 60 }, 96, 54, cache, [anchor]);
      // The same ray against every draw ("all", e.g. picking) still meets the foreground surface in front of the anchor.
      const projection = mesh3dProjection(mesh3dCameraAt(segment, 0), 96 / 54);
      const all = mesh3dRayDepthV1(projection, segment.objects.map(o => ({ object: o, time: 0, mesh: cache.get(o.geometry) })));
      return { visibility: frame.anchors[0].visibility, anchorDepth: frame.anchors[0].depthNdc!, allDepth: all(frame.anchors[0].x!, frame.anchors[0].y!) };
    }
    it("band text in front of an anchor does not hide it; its surface would have", () => {
      // Cylinder band around the origin: the ray to the anchor crosses the band's front strip.
      const result = behind({ geometry: { kind: "band_text", text: "SOMEONE", font: "latin", weight: 400, form: "cylinder", facing: "outside", radius: 1.2, height: .3, segments: 64, repeat: 2, tracking: .05 },
        material: { unlit: true, color: "#FFFFFF" }, position: [0, 0, 0] });
      expect(result.allDepth).toBeLessThan(result.anchorDepth);
      expect(result.visibility).toBe("visible");
    });
    it("a line-only wireframe in front does not hide it; a filled wireframe and a solid still do", () => {
      const sheet = { kind: "box", width: 2, height: 2, depth: .1 } as const;
      const lines = behind({ geometry: sheet, material: { wireframe: { color: "#00FFAA", width: 1, divisions: [4, 4], fill: false } } });
      expect(lines.allDepth).toBeLessThan(lines.anchorDepth);
      expect(lines.visibility).toBe("visible");
      expect(behind({ geometry: sheet, material: { wireframe: { color: "#00FFAA", width: 1, divisions: [4, 4], fill: true } } }).visibility).toBe("occluded");
      expect(behind({ geometry: sheet }).visibility).toBe("occluded");
    });
    it("keeps every draw for the default (picking) and refuses an unknown occluder mode", () => {
      const input = scene(), segment = input.segments[0], cache = new Mesh3dGeometryCache();
      const draws = segment.objects.map(o => ({ object: o, time: 0, mesh: cache.get(o.geometry) })), projection = mesh3dProjection(segment.camera, 96 / 54);
      expect(mesh3dRayDepthV1(projection, draws)(.5, .5)).toBe(mesh3dRayDepthV1(projection, draws, { occluders: "opaque" })(.5, .5));
      expect(() => mesh3dRayDepthV1(projection, draws, { occluders: "glass" as "all" })).toThrow("MESH_RAY_OCCLUDERS_INVALID");
    });
  });
  it("rejects absent/ambiguous targets, invalid local points, clocks and oversized bindings", () => {
    expect(() => render(scene(), [{ ...binding(), objectId: "absent" }])).toThrow("TARGET_MISSING");
    expect(() => render(scene(), [binding(), binding()])).toThrow("BINDING_INVALID");
    expect(() => render(scene(), [{ ...binding(), localPoint: [NaN, 0, 0] }])).toThrow("BINDING_INVALID");
    expect(() => render(scene(), Array.from({ length: 129 }, (_, i) => ({ ...binding(), id: `a${i}` })))).toThrow("BUDGET");
    expect(() => render(scene(), [binding()], .5)).toThrow("CLOCK");
    const input = scene(); input.segments[0].objects.push(object());
    expect(() => render(input)).toThrow("OBJECT_AMBIGUOUS");
  });
});
