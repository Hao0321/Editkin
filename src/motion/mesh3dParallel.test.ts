import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Mesh3dGeometryCache, mesh3dSceneTextFaceIdsV1, parseMesh3dFont } from "./mesh3dGeometry";
import { renderMesh3dFrame, type Mesh3dFrame, type Mesh3dRasterOptionsV1, type Mesh3dTexture } from "./mesh3dRasterizer";
import { mesh3dGeometrySchema, mesh3dMaterialSchema, mesh3dSceneSchema, type Mesh3dObject, type Mesh3dScene } from "./mesh3dScene";
import { renderMesh3dProjectFrameV1 } from "./mesh3dProjectFrameV1";
import { mesh3dBounceKeyframesV1 } from "./mesh3dAnimation";
import { Mesh3dWorkerPoolV1, mesh3dDefaultThreadsV1 } from "./mesh3dParallel";

/**
 * Worker-thread rendering is byte-identical to renderMesh3dFrame for every thread count:
 * legacy per-vertex scenes, per-pixel materials, every post effect (incl. motion blur,
 * odd sizes against the quarter grid), the polish features and the overlay adapter.
 */
const FONT_ROOT = join(import.meta.dirname, "../../public/fonts/render");
const face = (id: string) => { const b = readFileSync(join(FONT_ROOT, `${id}.ttf`)); return parseMesh3dFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const cacheFor = (scene: Mesh3dScene) => new Mesh3dGeometryCache(new Map([[900, face("EditkinFace-noto-sans-tc-900")]]), new Map(mesh3dSceneTextFaceIdsV1(scene).map(id => [id, face(id)])));
type V = [number, number, number];
const pose = (position: V = [0, 0, 0], rotationDegrees: V = [0, 0, 0], scale: V = [1, 1, 1]) => ({ position, rotationDegrees, scale });
const object = (id: string, geometry: object, material: object = {}, at = pose()): Mesh3dObject =>
  ({ id, name: id, geometry: mesh3dGeometrySchema.parse(geometry), pose: at, keyframes: [], material: mesh3dMaterialSchema.parse({ color: "#E04080", unlit: false, ...material }) });
const scene = (objects: Mesh3dObject[], extra: Record<string, unknown> = {}, background: object = {}, cameraExtra: object = {}): Mesh3dScene => mesh3dSceneSchema.parse({
  schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#101828", gridColor: "#3050A0", spacing: 40, grid: false, ...background },
  light: { direction: [-.5, .9, .7], ambient: .35, intensity: .8 },
  segments: [{ id: "s", name: "s", timelineStart: 0, duration: 2, camera: { position: [.4, 1.4, 4.4], target: [0, .2, 0], verticalFovDegrees: 50, near: .1, far: 30, ...cameraExtra },
    cameraKeyframes: [{ time: 2, camera: { position: [1.6, 1.1, 3.9], target: [0, .2, 0], verticalFovDegrees: 52, near: .1, far: 30, ...cameraExtra }, easing: "smooth" }], objects }], ...extra });
function texture(width: number, height: number, alpha = false): Mesh3dTexture {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4; rgba[p] = (x * 37) & 255; rgba[p + 1] = (y * 53) & 255; rgba[p + 2] = ((x ^ y) * 29) & 255;
    rgba[p + 3] = alpha ? Math.min(255, Math.round(Math.hypot(x - width / 2, y - height / 2) < Math.min(width, height) * .45 ? 255 : 40 * ((x + y) % 7))) : 255;
  }
  return { width, height, rgba };
}
const bounce = (id: string, x: number, geometry: object, material: object) => {
  const track = mesh3dBounceKeyframesV1({ start: pose([x, 1.2, 0]), floorY: -.5, contactOffset: .25, restitution: .5, bounces: 2, squash: .2, until: 2 });
  return { ...object(id, geometry, material), pose: track.pose, keyframes: track.keyframes };
};

function cases(): Record<string, { scene: Mesh3dScene; time: number; size: [number, number]; textures?: Map<string, Mesh3dTexture>; options?: Mesh3dRasterOptionsV1 }> {
  const clip = texture(64, 36), legacy = scene([
    object("box", { kind: "box", width: 1, height: .8, depth: .6 }, {}, pose([-1, .3, 0], [20, 30, 5])),
    object("torus", { kind: "torus", radius: .6, tube: .12, segments: 32 }, { doubleSided: true }, pose([0, -.4, .2], [70, 0, 0])),
    object("floor", { kind: "box", width: 6, height: .05, depth: 6 }, { color: "#F8FAFF", unlit: true, grid: true }, pose([0, -1, 0])),
    object("screen", { kind: "curved_video", radius: 3, width: 2, height: 1.2, segments: 24 }, { color: "#FFFFFF", unlit: true, clipId: "clip" }, pose([0, .9, -1.2])),
    object("title", { kind: "text", text: "實A", fontFamily: "Noto Sans TC", fontWeight: 900, height: .5, depth: .12, bevel: .01 }, { color: "#175CD3" }, pose([.6, 1.2, .4])),
  ], {}, { grid: true });
  const materials = [
    object("band", { kind: "band_text", text: "SOMEONE", font: "latin", weight: 400, form: "cylinder", facing: "outside", radius: 1.2, height: .3, segments: 64, repeat: 2, tracking: .05 }, { unlit: true, color: "#FFE0F0" }, pose([0, .4, 0], [-6, 20, 3])),
    object("wire", { kind: "sphere", radius: .5, segments: 24 }, { wireframe: { color: "#F868A8", width: 2, divisions: [12, 6], fill: false }, doubleSided: true }, pose([1.2, .3, 0])),
    object("stripes", { kind: "torus", radius: .4, tube: .15, segments: 32 }, { stripes: { colors: ["#FFFFFF", "#F868A8"], count: 8, angleDegrees: 30 } }, pose([-1.2, .2, .3], [60, 0, 0])),
    object("chrome", { kind: "text_extrude", text: "OK", font: "display", weight: 900, size: .7, depth: .2, bevelSize: .02, bevelThickness: .03, bevelSegments: 2, tracking: 0 },
      { gradient: { colors: ["#2B3C86", "#F2F5FF"], axis: "y" }, specular: { strength: 1, shininess: 120 }, reflection: { strength: .5, sky: "#9FB6FF", horizon: "#FFFFFF", ground: "#081236" }, edgeLight: { color: "#6E8BFF", strength: .6, power: 3 } }, pose([0, -.5, .8], [-10, -10, 0])),
    object("glow", { kind: "star", points: 5, outerRadius: .3, innerRadius: .14, depth: .1, bevel: .02, bevelSegments: 2 }, { emissive: { color: "#FF66AA", strength: 1.4 } }, pose([.8, 1.1, .4])),
  ];
  const lights = { fill: { direction: [.9, 0, -.2], intensity: .6, color: "#F868A8" }, hemisphere: { sky: "#FFFFFF", ground: "#480818", intensity: .25 } };
  const post = { bloom: { threshold: .7, strength: 1, radius: .06 }, dof: { focusDistance: 4.2, aperture: .012 }, vignette: { strength: .5, softness: .55 } };
  const polishTextures = new Map([["ui", texture(200, 120)], ["card", texture(96, 96, true)]]);
  const polished = scene([
    object("floor", { kind: "box", width: 8, height: .05, depth: 8 }, { color: "#5A1230", grid: true, gridStyle: { cells: 24, lineWidthPx: 1.5, color: "#C8467E", fade: { start: 3, end: 9 } }, castShadow: false }, pose([0, -.525, 0])),
    bounce("ball", -.9, { kind: "sphere", radius: .25, segments: 24 }, { color: "#F868A8", specular: { strength: .5, shininess: 40 }, roughness: .35 }),
    bounce("ring", .9, { kind: "torus", radius: .2, tube: .08, segments: 32, tubeSegments: 24 }, { color: "#F8D8E8", stripes: { colors: ["#F8D8E8", "#F868A8"], count: 10, angleDegrees: 0 } }),
    object("screen", { kind: "box", width: 1.6, height: 1, depth: .01, uvMode: "front" }, { color: "#0E1220", unlit: true, clipId: "ui", texture: { filter: "mipmap", alpha: false }, receiveShadow: true }, pose([0, .6, -.8], [0, 10, 0])),
    object("card", { kind: "box", width: .6, height: .6, depth: .01, uvMode: "front" }, { color: "#FFFFFF", unlit: true, clipId: "card", texture: { filter: "mipmap", alpha: true }, doubleSided: true }, pose([-.4, .7, -.3], [0, 20, -5])),
    object("hero", { kind: "rounded_box", width: .8, height: .5, depth: .3, radius: .08, segments: 3 }, { color: "#E8A0C8", specular: { strength: 1, shininess: 60 }, roughness: .3 }, pose([.5, 0, .4], [0, -25, 0])),
  ], { light: { direction: [-.55, .85, .9], ambient: .22, intensity: .95, size: 12, distance: 7, shadow: { strength: .8, softness: 3, mapSize: 512 }, ...lights },
    post: { ...post, ao: { strength: .85, radius: .4 } } }, { radial: { color: "#8A1A4C", center: [.5, .36], radius: .5, strength: .75 } }, { roll: -4 });
  const mover = { ...object("mover", { kind: "box", width: .4, height: .4, depth: .4 }, { color: "#FFFFFF", unlit: true }), keyframes: [{ time: 2, pose: pose([3, 0, 0]), easing: "linear" as const }], pose: pose([-3, 0, 0]) };
  return {
    "legacy per-vertex + grid + video texture": { scene: legacy, time: .73, size: [160, 240], textures: new Map([["clip", clip]]) },
    "legacy, float64 depth": { scene: legacy, time: 1.3, size: [120, 90], textures: new Map([["clip", clip]]), options: { depthPrecision: "float64" } },
    "extended materials, no post, HDR out": { scene: scene(materials, { light: { direction: [-.5, .9, .7], ambient: .3, intensity: .8, ...lights } }, { radial: { color: "#C04080", center: [.5, .4], radius: .5, strength: .8 } }), time: .5, size: [160, 240], options: { hdr: true } },
    "bloom + DOF + vignette, odd size": { scene: scene(materials, { light: { direction: [-.5, .9, .7], ambient: .3, intensity: .8, ...lights }, post }), time: .9, size: [157, 203] },
    "motion blur + fisheye": { scene: scene([mover, ...materials.slice(0, 2)], { post: { motionBlur: { shutterSeconds: .1, samples: 6 }, fisheye: { strength: .4 }, bloom: post.bloom } }), time: 1, size: [144, 176] },
    "polish: shadows, AO, area key, grid style, mip/alpha textures, roll": { scene: polished, time: .9, size: [160, 240], textures: polishTextures, options: { depthPrecision: "float64" } },
    "polish + motion blur": { scene: mesh3dSceneSchema.parse({ ...polished, post: { ...polished.post, motionBlur: { shutterSeconds: .05, samples: 3 } } }), time: 1.3, size: [128, 192], textures: polishTextures },
  };
}
const bytes = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function same(a: Mesh3dFrame, b: Mesh3dFrame): string[] {
  const out: string[] = [];
  if (bytes(a.rgba).compare(bytes(b.rgba))) out.push("rgba");
  if (bytes(a.depth).compare(bytes(b.depth))) out.push("depth");
  if (Boolean(a.depthPrecise) !== Boolean(b.depthPrecise) || (a.depthPrecise && bytes(a.depthPrecise).compare(bytes(b.depthPrecise!)))) out.push("depthPrecise");
  if (Boolean(a.hdr) !== Boolean(b.hdr) || (a.hdr && bytes(a.hdr).compare(bytes(b.hdr!)))) out.push("hdr");
  if (a.triangleCount !== b.triangleCount || a.rasterizedTriangles !== b.rasterizedTriangles) out.push(`counts ${a.rasterizedTriangles}/${b.rasterizedTriangles}`);
  return out;
}

const pools = new Map<number, Mesh3dWorkerPoolV1>();
const pool = (threads: number) => { let p = pools.get(threads); if (!p) { p = new Mesh3dWorkerPoolV1({ threads }); pools.set(threads, p); } return p; };
afterAll(async () => { await Promise.all([...pools.values()].map(p => p.close())); });

describe("worker-thread rendering", () => {
  const all = cases();
  it.each(Object.keys(all))("%s: identical bytes for 1, 2, 3 and 7 threads", async name => {
    const c = all[name], cache = cacheFor(c.scene), textures = c.textures ?? new Map();
    const reference = renderMesh3dFrame(c.scene, c.time, c.size[0], c.size[1], cache, textures, c.options);
    for (const threads of [1, 2, 3, 7]) {
      const frame = await pool(threads).render(c.scene, c.time, c.size[0], c.size[1], cache, textures, c.options);
      expect(same(frame, reference), `${threads} threads`).toEqual([]);
    }
  }, 120_000);
  it("returns frames the caller owns (not views of shared memory) and keeps call order", async () => {
    const c = all["bloom + DOF + vignette, odd size"], cache = cacheFor(c.scene), p = pool(3);
    const times = [.1, .6, 1.1, 1.7], frames = await Promise.all(times.map(t => p.render(c.scene, t, c.size[0], c.size[1], cache)));
    times.forEach((t, i) => {
      expect(frames[i].rgba.buffer instanceof SharedArrayBuffer).toBe(false);
      expect(same(frames[i], renderMesh3dFrame(c.scene, t, c.size[0], c.size[1], cache))).toEqual([]);
    });
    expect(new Set(frames.map(f => createHash("sha256").update(f.rgba).digest("hex"))).size).toBe(times.length);
  }, 120_000);
  it("renders the overlay adapter identically (world-anchored billboards on float64 depth)", async () => {
    const base = cases()["legacy per-vertex + grid + video texture"].scene;
    const overlay = mesh3dSceneSchema.parse({ ...base, post: { bloom: { threshold: .8, strength: .5, radius: .05 } }, overlaysV1: { schema: "editkin.mesh-overlays/v1", anchors: [{ id: "a", segmentId: "s", objectId: "box", localPoint: [0, .4, .3] }],
      layers: [{ id: "l", anchorId: "a", clipId: "label", size: [.25, .1], offset: [0, -.03], pivot: [.5, 1], opacity: .9, occlusion: "depth_test" }] } });
    const cache = cacheFor(overlay), textures = new Map([["clip", texture(64, 36)], ["label", texture(48, 20, true)]]);
    for (const timelineFrame of [7, 41]) {
      const reference = renderMesh3dProjectFrameV1(overlay, { timelineFrame, fps: 30 }, 160, 240, cache, textures);
      for (const threads of [2, 7]) expect(same(await pool(threads).renderProjectFrame(overlay, { timelineFrame, fps: 30 }, 160, 240, cache, textures), reference)).toEqual([]);
    }
  }, 120_000);
  it("reports the same errors and stays usable afterwards", async () => {
    const c = all["legacy per-vertex + grid + video texture"], cache = cacheFor(c.scene), p = pool(2);
    await expect(p.render(c.scene, .5, 64, 64, cache)).rejects.toThrow("3D 材質未解碼：clip");
    await expect(p.render(c.scene, .5, 0, 64, cache, c.textures)).rejects.toThrow("3D 輸出尺寸超出上限");
    expect(same(await p.render(c.scene, .5, 64, 64, cache, c.textures), renderMesh3dFrame(c.scene, .5, 64, 64, cache, c.textures))).toEqual([]);
  }, 120_000);
  it("validates the thread count and picks a sensible default", () => {
    expect(() => new Mesh3dWorkerPoolV1({ threads: 0 })).toThrow("MESH_PARALLEL_THREADS_INVALID");
    expect(() => new Mesh3dWorkerPoolV1({ threads: 1.5 })).toThrow("MESH_PARALLEL_THREADS_INVALID");
    expect(mesh3dDefaultThreadsV1()).toBeGreaterThanOrEqual(1); expect(mesh3dDefaultThreadsV1()).toBeLessThanOrEqual(12);
  });
});
