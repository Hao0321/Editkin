import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Mesh3dGeometryCache, mesh3dSceneTextFaceIdsV1, parseMesh3dFont, MESH3D_GEOMETRY_CACHE_ENTRIES } from "./mesh3dGeometry";
import { MESH3D_MAX_OBJECTS, MESH3D_MAX_SCENE_TRIANGLES, MESH3D_MAX_TEXTURES, mesh3dProjection, rasterizeMesh3d, renderMesh3dFrame, type Mesh3dFrame, type Mesh3dTexture } from "./mesh3dRasterizer";
import { mesh3dCameraAt, mesh3dGeometrySchema, mesh3dMaterialSchema, mesh3dPostSchema, mesh3dSceneSchema, mesh3dSegmentSchema, type Mesh3dObject, type Mesh3dScene } from "./mesh3dScene";
import { Vector3 } from "three";

/**
 * Polish fields (2026-10-23): schema, golden renders and behaviour of soft key-light
 * shadows, SSAO, GGX roughness / sized and positional key light, torus tube segments,
 * filtered alpha textures, camera roll, grid styles, adaptive legacy text curves, box UV
 * modes and the raised scene budgets. Every field is optional; scenes without them keep
 * their bytes (mesh3dLegacyIdentity.test.ts, mesh3dExtension.test.ts).
 */
const FONT_ROOT = join(import.meta.dirname, "../../public/fonts/render");
const faceCache = new Map<string, ReturnType<typeof parseMesh3dFont>>();
const face = (id: string) => { let f = faceCache.get(id); if (!f) { const b = readFileSync(join(FONT_ROOT, `${id}.ttf`)); f = parseMesh3dFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); faceCache.set(id, f); } return f; };
const notoWeights = () => new Map([[700, face("EditkinFace-noto-sans-tc-700")], [900, face("EditkinFace-noto-sans-tc-900")]]);
const cacheFor = (scene: Mesh3dScene) => new Mesh3dGeometryCache(notoWeights(), new Map(mesh3dSceneTextFaceIdsV1(scene).map(id => [id, face(id)])));
type V = [number, number, number];
const pose = (position: V = [0, 0, 0], rotationDegrees: V = [0, 0, 0], scale: V = [1, 1, 1]) => ({ position, rotationDegrees, scale });
const object = (id: string, geometry: object, material: object = {}, at = pose()): Mesh3dObject =>
  ({ id, name: id, geometry: mesh3dGeometrySchema.parse(geometry), pose: at, keyframes: [], material: mesh3dMaterialSchema.parse({ color: "#E04080", unlit: false, ...material }) });
const camera = (extra: object = {}) => ({ position: [0, 1.6, 4.2] as V, target: [0, .2, 0] as V, verticalFovDegrees: 50, near: .1, far: 30, ...extra });
function scene(objects: Mesh3dObject[], extra: Record<string, unknown> = {}, cameraExtra: object = {}): Mesh3dScene {
  const { light, ...rest } = extra as { light?: object };
  return mesh3dSceneSchema.parse({ schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#101020", gridColor: "#5060A0", spacing: 72, grid: false },
    light: { direction: [-.5, .9, .7], ambient: .3, intensity: .8, ...(light ?? {}) },
    segments: [{ id: "s", name: "s", timelineStart: 0, duration: 2, camera: camera(cameraExtra), cameraKeyframes: [], objects }], ...rest });
}
const sha = (frame: Mesh3dFrame) => createHash("sha256").update(frame.rgba).digest("hex").slice(0, 20);
const lum = (f: Mesh3dFrame, w: number, x: number, y: number) => { const p = (y * w + x) * 4; return .2126 * f.rgba[p] + .7152 * f.rgba[p + 1] + .0722 * f.rgba[p + 2]; };
const W = 96, H = 128;
const render = (s: Mesh3dScene, textures = new Map<string, Mesh3dTexture>(), w = W, h = H, time = .5) => renderMesh3dFrame(s, time, w, h, cacheFor(s), textures);

/** 64×64 checker with a red quadrant marker and rounded transparent corners (radius 12 px). */
function checker(size = 64, cell = 4, rounded = true): Mesh3dTexture {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const p = (y * size + x) * 4, on = ((x / cell | 0) + (y / cell | 0)) % 2 === 0, marker = x < size / 2 && y < size / 2;
    rgba[p] = on ? 240 : 30; rgba[p + 1] = marker ? 40 : on ? 240 : 30; rgba[p + 2] = marker ? 40 : on ? 240 : 30;
    const cx = Math.min(x + .5, size - x - .5), cy = Math.min(y + .5, size - y - .5), r = 12;
    rgba[p + 3] = rounded && cx < r && cy < r ? Math.round(255 * Math.max(0, Math.min(1, .5 - (Math.hypot(r - cx, r - cy) - r)))) : 255;
  }
  return { width: size, height: size, rgba };
}
const floor = (material: object = {}) => object("floor", { kind: "box", width: 6, height: .05, depth: 6 }, { color: "#C8C4BC", ...material }, pose([0, -.55, 0]));

describe("polish schema", () => {
  const good: Record<string, unknown> = {
    torus: { kind: "torus", radius: .8, tube: .3, segments: 48, tubeSegments: 32 },
    text: { kind: "text", text: "字A", fontFamily: "Noto Sans TC", fontWeight: 900, height: .5, depth: .1, bevel: .01, curveSegments: 12 },
    boxFront: { kind: "box", width: 1, height: 1, depth: .01, uvMode: "front" },
    boxAtlas: { kind: "box", width: 1, height: 1, depth: 1, uvMode: "atlas" },
    boxRepeat: { kind: "box", width: 1, height: 1, depth: 1, uvMode: "repeat" },
    roundedFront: { kind: "rounded_box", width: 1, height: .6, depth: .1, radius: .04, segments: 2, uvMode: "front" },
    roundedPlanar: { kind: "rounded_box", width: 1, height: .6, depth: .1, radius: .04, segments: 2, uvMode: "planar" },
  };
  const bad: [string, unknown][] = [
    ["tubeSegments too few", { ...good.torus as object, tubeSegments: 2 }], ["tubeSegments too many", { ...good.torus as object, tubeSegments: 65 }],
    ["tubeSegments fraction", { ...good.torus as object, tubeSegments: 8.5 }],
    ["curveSegments zero", { ...good.text as object, curveSegments: 0 }], ["curveSegments too many", { ...good.text as object, curveSegments: 33 }],
    ["box uvMode", { ...good.boxFront as object, uvMode: "back" }], ["rounded uvMode", { ...good.roundedFront as object, uvMode: "atlas" }],
  ];
  it("accepts the new geometry fields", () => { for (const [name, value] of Object.entries(good)) expect(mesh3dGeometrySchema.safeParse(value).success, name).toBe(true); });
  it.each(bad)("rejects %s", (_, value) => { expect(mesh3dGeometrySchema.safeParse(value).success).toBe(false); });

  const base = { color: "#FFFFFF", unlit: false };
  const materials: [string, object, boolean][] = [
    ["roughness", { roughness: .4 }, true], ["roughness 0", { roughness: 0 }, true], ["roughness > 1", { roughness: 1.2 }, false], ["roughness negative", { roughness: -.1 }, false],
    ["texture mipmap alpha", { clipId: "c", texture: { filter: "mipmap", alpha: true } }, true], ["texture nearest", { clipId: "c", texture: { filter: "nearest", alpha: false } }, true],
    ["texture bilinear", { clipId: "c", texture: { filter: "bilinear", alpha: false } }, true],
    ["texture without clip", { texture: { filter: "mipmap", alpha: true } }, false], ["texture filter", { clipId: "c", texture: { filter: "anisotropic", alpha: true } }, false],
    ["texture missing alpha", { clipId: "c", texture: { filter: "mipmap" } }, false],
    ["gridStyle", { grid: true, gridStyle: { cells: 24, lineWidthPx: 1.5 } }, true], ["gridStyle pair + fade + colour", { grid: true, gridStyle: { cells: [16, 8], lineWidthPx: 1, color: "#C8467E", fade: { start: 4, end: 12 } } }, true],
    ["gridStyle without grid", { gridStyle: { cells: 24, lineWidthPx: 1.5 } }, false], ["gridStyle cells", { grid: true, gridStyle: { cells: 0, lineWidthPx: 1 } }, false],
    ["gridStyle line width", { grid: true, gridStyle: { cells: 8, lineWidthPx: 20 } }, false], ["gridStyle fade order", { grid: true, gridStyle: { cells: 8, lineWidthPx: 1, fade: { start: 9, end: 3 } } }, false],
    ["castShadow/receiveShadow", { castShadow: false, receiveShadow: true }, true], ["castShadow type", { castShadow: "no" }, false],
  ];
  it.each(materials)("material %s", (_, extra, ok) => { expect(mesh3dMaterialSchema.safeParse({ ...base, ...extra }).success).toBe(ok); });

  it("validates key light size / distance / shadow, camera roll, AO and the object budget", () => {
    const s = scene([object("a", { kind: "box", width: 1, height: 1, depth: 1 })]);
    const parse = (patch: object) => mesh3dSceneSchema.safeParse({ ...s, ...patch }).success;
    const light = (extra: object) => ({ light: { ...s.light, ...extra } });
    expect(parse(light({ size: 12, distance: 8, shadow: { strength: .8, softness: 3, mapSize: 2048 } }))).toBe(true);
    expect(parse(light({ shadow: { strength: .8, softness: 3 } }))).toBe(true);
    for (const wrong of [{ size: 60 }, { size: -1 }, { distance: .1 }, { distance: 500 }, { shadow: { strength: 2, softness: 3 } }, { shadow: { strength: .5, softness: 40 } },
      { shadow: { strength: .5, softness: 3, mapSize: 128 } }, { shadow: { strength: .5, softness: 3, mapSize: 5000 } }, { shadow: { strength: .5 } }, { shadow: { strength: .5, softness: 2, bias: 1 } }])
      expect(parse(light(wrong)), JSON.stringify(wrong)).toBe(false);
    const segment = s.segments[0];
    expect(mesh3dSegmentSchema.safeParse({ ...segment, camera: { ...segment.camera, roll: -15 } }).success).toBe(true);
    expect(mesh3dSegmentSchema.safeParse({ ...segment, camera: { ...segment.camera, roll: 4000 } }).success).toBe(false);
    expect(mesh3dSegmentSchema.safeParse({ ...segment, camera: { ...segment.camera, roll: "left" } }).success).toBe(false);
    expect(mesh3dPostSchema.safeParse({ ao: { strength: .8, radius: .4 } }).success).toBe(true);
    for (const wrong of [{ ao: { strength: 1.5, radius: .4 } }, { ao: { strength: .5, radius: 0 } }, { ao: { strength: .5, radius: 20 } }, { ao: { strength: .5 } }, { ao: { strength: .5, radius: .3, samples: 8 } }])
      expect(mesh3dPostSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    const many = Array.from({ length: MESH3D_MAX_OBJECTS }, (_, i) => ({ ...segment.objects[0], id: `o${i}` }));
    expect(MESH3D_MAX_OBJECTS).toBe(128);
    expect(mesh3dSegmentSchema.safeParse({ ...segment, objects: many }).success).toBe(true);
    expect(mesh3dSegmentSchema.safeParse({ ...segment, objects: [...many, { ...segment.objects[0], id: "extra" }] }).success).toBe(false);
  });
  it("interpolates roll only when a camera has it", () => {
    const s = scene([object("a", { kind: "box", width: 1, height: 1, depth: 1 })]);
    const segment = { ...s.segments[0], cameraKeyframes: [{ time: 2, camera: camera({ roll: 20 }), easing: "linear" as const }] };
    expect(mesh3dCameraAt(segment, 1).roll).toBeCloseTo(10, 12);
    expect("roll" in mesh3dCameraAt(s.segments[0], 1)).toBe(false);
  });
});

/** Golden pixel hashes (96×128) of each polish feature, captured from this implementation. */
function goldenScenes(): Record<string, { scene: Mesh3dScene; textures?: Map<string, Mesh3dTexture> }> {
  const ball = (material: object = {}, at: V = [0, .2, 0]) => object("ball", { kind: "sphere", radius: .45, segments: 32 }, { color: "#E85A4F", ...material }, pose(at));
  const tex = new Map([["c", checker()]]), fine = new Map([["c", checker(256, 1, false)]]);
  const plane = (geometry: object, material: object, at = pose([0, .3, .4], [-20, 0, 0])) => object("plane", geometry, { color: "#3060F0", unlit: true, clipId: "c", doubleSided: true, ...material }, at);
  const shadow = { size: 0, shadow: { strength: .85, softness: 3, mapSize: 512 } };
  return {
    "light:size": { scene: scene([ball({ specular: { strength: 1, shininess: 80 } })], { light: { size: 15 } }) },
    "light:distance": { scene: scene([object("slab", { kind: "box", width: 2.4, height: 1.6, depth: .2 }, { color: "#D0A0C0", specular: { strength: .8, shininess: 40 }, roughness: .3 }, pose([0, .3, 0], [0, -20, 0]))], { light: { size: 12, distance: 3.5 } }) },
    "light:shadow": { scene: scene([floor(), ball({}, [-.3, .35, .2]), object("cube", { kind: "box", width: .5, height: .5, depth: .5 }, { color: "#4F7FE8" }, pose([.6, -.27, -.3], [0, 30, 0]))], { light: shadow }) },
    "light:shadow-unlit-catcher": { scene: scene([floor({ unlit: true, color: "#E8E8E8", receiveShadow: true }), ball({}, [0, .1, 0])], { light: shadow }) },
    "material:roughness": { scene: scene([ball({ color: "#808080", roughness: .55, specular: { strength: 1.2, shininess: 64 }, reflection: { strength: .7, sky: "#AFC4FF", horizon: "#FFFFFF", ground: "#081236" } })]) },
    "material:texture-nearest": { scene: scene([plane({ kind: "box", width: 2.2, height: 2.2, depth: .01 }, { texture: { filter: "nearest", alpha: false } })]), textures: tex },
    "material:texture-bilinear": { scene: scene([plane({ kind: "box", width: 2.2, height: 2.2, depth: .01 }, { texture: { filter: "bilinear", alpha: false } })]), textures: tex },
    "material:texture-mipmap": { scene: scene([plane({ kind: "box", width: 5, height: 5, depth: .01 }, { texture: { filter: "mipmap", alpha: false } }, pose([0, -.4, -1], [-75, 0, 0]))]), textures: fine },
    "material:texture-alpha": { scene: scene([ball({}, [0, 0, -1.2]), plane({ kind: "box", width: 2.2, height: 2.2, depth: .01, uvMode: "front" }, { texture: { filter: "mipmap", alpha: true } })]), textures: tex },
    "material:gridStyle": { scene: scene([object("grid", { kind: "box", width: 12, height: .02, depth: 12 }, { color: "#20203A", grid: true, gridStyle: { cells: 24, lineWidthPx: 6, color: "#F868A8", fade: { start: 3, end: 8 } } }, pose([0, -.4, -2]))]) },
    "camera:roll": { scene: scene([object("bar", { kind: "box", width: 2.4, height: .25, depth: .25 }, { color: "#F0C040" }, pose([0, .2, 0]))], {}, { roll: 30 }) },
    "geometry:torus-tubeSegments": { scene: scene([object("t", { kind: "torus", radius: .8, tube: .35, segments: 48, tubeSegments: 32 }, { color: "#40C0FF" }, pose([0, .2, 0], [60, 0, 0]))]) },
    "geometry:text-curveSegments": { scene: scene([object("t", { kind: "text", text: "說O", fontFamily: "Noto Sans TC", fontWeight: 900, height: .9, depth: .15, bevel: .01, curveSegments: 16 }, { color: "#175CD3" }, pose([0, .3, 0], [8, -12, 0]))]) },
    "geometry:box-uv-atlas": { scene: scene([plane({ kind: "box", width: 1.4, height: 1.4, depth: 1.4, uvMode: "atlas" }, {}, pose([0, .2, 0], [25, 35, 0]))]), textures: tex },
    "geometry:rounded_box-uv-front": { scene: scene([plane({ kind: "rounded_box", width: 1.8, height: 1.4, depth: .3, radius: .1, segments: 3, uvMode: "front" }, { unlit: false, texture: { filter: "bilinear", alpha: false } }, pose([0, .2, 0], [10, 35, 0]))]), textures: tex },
    "post:ao": { scene: scene([floor(), object("wall", { kind: "box", width: 3, height: 2, depth: .1 }, { color: "#C8C4BC" }, pose([0, .45, -.9])), ball({}, [.3, -.08, -.2])], { post: { ao: { strength: 1, radius: .5 } } }) },
  };
}
const GOLDEN: Record<string, string> = {
  "light:size": "333ccbb4fe9c9ecd12df",
  "light:distance": "411b7750c13ed6e500ec",
  "light:shadow": "3d399ae93c886091c00a",
  "light:shadow-unlit-catcher": "b419f3e7cbd873481870",
  "material:roughness": "99cb0f82dd2dda326778",
  "material:texture-nearest": "78efe67e15300586bf24",
  "material:texture-bilinear": "c127823ca7e9bf2ef93d",
  "material:texture-mipmap": "97dd0d15aedfb9028544",
  "material:texture-alpha": "1c5db938f671a8a55f03",
  "material:gridStyle": "dbc4bf1e54edfae6215e",
  "camera:roll": "de34da98411d42b23872",
  "geometry:torus-tubeSegments": "2a19e0c50ca49f3e8f7f",
  "geometry:text-curveSegments": "4da8068318c0e89075b4",
  "geometry:box-uv-atlas": "7ac9647aa812ef5aa0c7",
  "geometry:rounded_box-uv-front": "219db931393c55c69c7c",
  "post:ao": "710832a43e90a8b22797",
};

describe("golden renders of the polish features", () => {
  it("match the captured hashes", () => {
    const actual: Record<string, string> = {};
    for (const [name, { scene: s, textures }] of Object.entries(goldenScenes())) {
      const frame = render(s, textures); actual[name] = sha(frame);
      // Review aid: MESH3D_GOLDEN_DUMP=<dir> writes each golden as raw 96×128 RGBA.
      if (process.env.MESH3D_GOLDEN_DUMP) writeFileSync(join(process.env.MESH3D_GOLDEN_DUMP, name.replace(/[^a-z0-9-]/gi, "_") + ".rgba"), frame.rgba);
    }
    if (process.env.MESH3D_CAPTURE_GOLDEN) { console.log(JSON.stringify(actual, null, 2)); return; }
    expect(Object.keys(GOLDEN)).toHaveLength(Object.keys(actual).length);
    expect(actual).toEqual(GOLDEN);
  }, 120_000);
});

describe("polish features do what they say", () => {
  const all = goldenScenes();
  it("key-light shadows darken the floor under a caster, harden at contact and leave the receiver's own surface alone", () => {
    const g = all["light:shadow"], lit = mesh3dSceneSchema.parse({ ...g.scene, light: { ...g.scene.light, shadow: undefined } });
    expect(lit.light.size).toBe(0);
    const [w, h] = [192, 256], a = render(g.scene, undefined, w, h), b = render(lit, undefined, w, h);
    let darker = 0, brighter = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = lum(a, w, x, y) - lum(b, w, x, y); if (d < -8) darker++; if (d > 1) brighter++; }
    expect(darker).toBeGreaterThan(400); expect(brighter).toBe(0);
    // Contact hardening: a ball touching the floor casts a sharper edge than the same ball one unit up
    // (measured on the shadow alone: the difference from the same frame without shadows, top view, side light).
    const edge = (height: number) => {
      const make = (shadowed: boolean) => scene([floor(), object("ball", { kind: "sphere", radius: .3, segments: 32 }, {}, pose([0, height, 0]))],
        { light: { direction: [1, 1.2, 0], size: 0, ...(shadowed ? { shadow: { strength: 1, softness: 6, mapSize: 1024 } } : {}) } }, { position: [0, 4, .01], target: [0, 0, 0] });
      const a = render(make(true), undefined, 160, 160), b = render(make(false), undefined, 160, 160), d: number[] = [];
      for (let x = 0; x < 80; x++) d.push(lum(b, 160, x, 80) - lum(a, 160, x, 80));
      const peak = Math.max(...d);
      return { peak, ramp: d.filter(v => v > peak * .1 && v < peak * .9).length };
    };
    const contact = edge(-.23), raised = edge(.8);
    expect(contact.peak).toBeGreaterThan(40); expect(raised.peak).toBeGreaterThan(20);
    expect(contact.ramp).toBeLessThan(raised.ramp);
  }, 60_000);
  it("an unlit receiveShadow surface catches shadows; plain unlit surfaces do not", () => {
    const g = all["light:shadow-unlit-catcher"], plain = mesh3dSceneSchema.parse({ ...g.scene, segments: g.scene.segments.map(s => ({ ...s, objects: s.objects.map(o => o.id === "floor" ? { ...o, material: { ...o.material, receiveShadow: undefined } } : o) })) });
    const a = render(g.scene), b = render(plain);
    let darker = 0; for (let i = 0; i < W * H; i++) if (a.rgba[i * 4] < b.rgba[i * 4] - 20) darker++;
    expect(darker).toBeGreaterThan(40);
    // The unlit floor is otherwise its flat colour.
    expect(Array.from(b.rgba.slice((120 * W + 4) * 4, (120 * W + 4) * 4 + 3))).toEqual([232, 232, 232]);
  });
  it("AO darkens the crease between wall, floor and ball but not the open floor", () => {
    const g = all["post:ao"], open = mesh3dSceneSchema.parse({ ...g.scene, post: { ao: { strength: 0, radius: .5 } } });
    const [w, h] = [192, 256], a = render(g.scene, undefined, w, h), b = render(open, undefined, w, h);
    let darkest = 0, lighter = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = lum(a, w, x, y) - lum(b, w, x, y); darkest = Math.min(darkest, d); if (d > .5) lighter++; }
    expect(darkest).toBeLessThan(-15); expect(lighter).toBe(0);
    expect(Math.abs(lum(a, w, 20, h - 6) - lum(b, w, 20, h - 6))).toBeLessThan(2);
  });
  it("roughness widens the specular lobe and a sized key light softens it", () => {
    // The lobe alone: blue channel with specular minus the same sphere with zero specular strength; spread = pixels above half its peak.
    const sphere = (material: object, light: object = {}, strength = 1) => render(scene([object("s", { kind: "sphere", radius: .9, segments: 48 }, { color: "#202020", ...material, specular: { strength, shininess: 200 } })], { light: { size: 0, ...light } }), undefined, 160, 160);
    const lobe = (material: object, light: object = {}) => {
      const a = sphere(material, light), b = sphere(material, light, 0), d: number[] = [];
      for (let i = 0; i < 160 * 160; i++) d.push(a.rgba[i * 4 + 2] - b.rgba[i * 4 + 2]);
      const peak = Math.max(...d); return { peak, spread: d.filter(v => v > peak / 2).length };
    };
    const glossy = lobe({}), rough = lobe({ roughness: .5 }), sized = lobe({}, { size: 20 });
    expect(glossy.peak).toBeGreaterThan(100);
    expect(rough.spread).toBeGreaterThan(glossy.spread * 3);
    expect(sized.spread).toBeGreaterThan(glossy.spread * 2); expect(sized.peak).toBeLessThan(glossy.peak);
  });
  it("a positional key makes a flat face a gradient; a directional key leaves it flat", () => {
    const g = all["light:distance"], flat = mesh3dSceneSchema.parse({ ...g.scene, light: { ...g.scene.light, distance: undefined, size: undefined } });
    const variance = (f: Mesh3dFrame) => { const v: number[] = []; for (let x = 30; x < 66; x += 3) v.push(lum(f, W, x, 58)); return Math.max(...v) - Math.min(...v); };
    expect(variance(render(g.scene))).toBeGreaterThan(variance(render(flat)) + 8);
  });
  it("textures: nearest is blocky, bilinear is smooth, alpha cuts the corners, mipmaps tame a distant checker", () => {
    const n = render(all["material:texture-nearest"].scene, all["material:texture-nearest"].textures), b = render(all["material:texture-bilinear"].scene, all["material:texture-bilinear"].textures);
    const levels = (f: Mesh3dFrame) => { const s = new Set<number>(); for (let x = 20; x < 76; x++) s.add(f.rgba[(64 * W + x) * 4 + 2]); return s.size; };
    expect(levels(b)).toBeGreaterThan(levels(n));
    const alpha = render(all["material:texture-alpha"].scene, all["material:texture-alpha"].textures), opaque = render(mesh3dSceneSchema.parse({ ...all["material:texture-alpha"].scene,
      segments: all["material:texture-alpha"].scene.segments.map(s => ({ ...s, objects: s.objects.map(o => o.id === "plane" ? { ...o, material: { ...o.material, texture: { filter: "mipmap" as const, alpha: false } } } : o) })) }), all["material:texture-alpha"].textures);
    let differs = 0; for (let i = 0; i < W * H; i++) if (Math.abs(alpha.rgba[i * 4] - opaque.rgba[i * 4]) > 40) differs++;
    expect(differs).toBeGreaterThan(20); expect(differs).toBeLessThan(600);
    const m = all["material:texture-mipmap"], aliased = mesh3dSceneSchema.parse({ ...m.scene, segments: m.scene.segments.map(s => ({ ...s, objects: s.objects.map(o => ({ ...o, material: { ...o.material, texture: { filter: "bilinear" as const, alpha: false } } })) })) });
    // The far, heavily minified part of a receding checker (right half: the checker, not the marker quadrant).
    const contrast = (f: Mesh3dFrame) => { let lo = 255, hi = 0; for (let x = 52; x < 86; x++) { const v = f.rgba[(50 * W + x) * 4 + 2]; lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
    expect(contrast(render(m.scene, m.textures))).toBeLessThan(contrast(render(aliased, m.textures)) * .6);
  });
  it("box UV modes: front textures only +z, atlas maps each face to its own cell", () => {
    const cache = new Mesh3dGeometryCache();
    const front = cache.get(mesh3dGeometrySchema.parse({ kind: "box", width: 1, height: 1, depth: 1, uvMode: "front" })), repeat = cache.get(mesh3dGeometrySchema.parse({ kind: "box", width: 1, height: 1, depth: 1 }));
    expect(front.uvUntextured).toBe(true); expect(repeat.uvUntextured).toBeUndefined();
    for (let i = 0; i < 24; i++) expect(Number.isNaN(front.uvs[i * 2])).toBe(Math.floor(i / 4) !== 4);
    const atlas = cache.get(mesh3dGeometrySchema.parse({ kind: "box", width: 1, height: 1, depth: 1, uvMode: "atlas" }));
    for (let f = 0; f < 6; f++) for (let i = f * 4; i < f * 4 + 4; i++) {
      const u = atlas.uvs[i * 2], v = atlas.uvs[i * 2 + 1];
      expect(u).toBeGreaterThanOrEqual((f % 3) / 3 - 1e-6); expect(u).toBeLessThanOrEqual((f % 3 + 1) / 3 + 1e-6);
      expect(v).toBeGreaterThanOrEqual((1 - Math.floor(f / 3)) * .5 - 1e-6); expect(v).toBeLessThanOrEqual((2 - Math.floor(f / 3)) * .5 + 1e-6);
    }
    const rounded = cache.get(mesh3dGeometrySchema.parse({ kind: "rounded_box", width: 1, height: 1, depth: .4, radius: .1, segments: 2, uvMode: "front" }));
    for (let i = 0; i < rounded.uvs.length / 2; i++) expect(Number.isNaN(rounded.uvs[i * 2])).toBe(!(rounded.normals[i * 3 + 2] > 1e-6));
  });
  it("torus tube segments and adaptive text curves change only the tessellation", () => {
    const cache = new Mesh3dGeometryCache(notoWeights());
    expect(cache.get(mesh3dGeometrySchema.parse({ kind: "torus", radius: 1, tube: .3, segments: 48, tubeSegments: 32 })).indices.length / 3).toBe(48 * 32 * 2);
    expect(cache.get(mesh3dGeometrySchema.parse({ kind: "torus", radius: 1, tube: .3, segments: 48 })).indices.length / 3).toBe(48 * 8 * 2);
    const text = (curveSegments?: number) => cache.get(mesh3dGeometrySchema.parse({ kind: "text", text: "說O", fontFamily: "Noto Sans TC", fontWeight: 900, height: .9, depth: .15, bevel: .01, ...(curveSegments ? { curveSegments } : {}) }));
    const fixed = text(), coarse = text(1), fine = text(16);
    expect(fine.indices.length).toBeGreaterThan(fixed.indices.length);
    expect(coarse.indices.length).toBeLessThan(fine.indices.length);
    const span = (m: typeof fine) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < m.positions.length; i += 3) { lo = Math.min(lo, m.positions[i]); hi = Math.max(hi, m.positions[i]); } return hi - lo; };
    expect(span(fine)).toBeCloseTo(span(fixed), 2);
  });
  it("camera roll turns the image about the line of sight; roll 0 is the unrolled camera", () => {
    const s = all["camera:roll"].scene, segment = s.segments[0];
    const rolled = mesh3dProjection(segment.camera, 1), level = mesh3dProjection({ ...segment.camera, roll: undefined }, 1), zero = mesh3dProjection({ ...segment.camera, roll: 0 }, 1);
    expect(zero.elements).toEqual(level.elements);
    const right = new Vector3(1.2, .2, 0), centre = new Vector3(0, .2, 0);
    const angle = (m: typeof rolled) => { const a = centre.clone().applyMatrix4(m), b = right.clone().applyMatrix4(m); return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; };
    expect(angle(level)).toBeCloseTo(0, 3);
    expect(angle(rolled)).toBeLessThan(-20); // positive roll turns the image clockwise
  });
  it("grid style lines fade with camera distance", () => {
    const g = all["material:gridStyle"], f = render(g.scene, undefined, 192, 256);
    const rowContrast = (y: number) => { let lo = 255, hi = 0; for (let x = 0; x < 192; x++) { const v = lum(f, 192, x, y); lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
    expect(rowContrast(250)).toBeGreaterThan(30);
    expect(rowContrast(100)).toBeLessThan(rowContrast(250) / 3);
  });
  it("raises the budgets: 128 objects and 16 textures render; one more of either, or too many triangles, is refused", () => {
    expect([MESH3D_MAX_OBJECTS, MESH3D_MAX_TEXTURES, MESH3D_MAX_SCENE_TRIANGLES, MESH3D_GEOMETRY_CACHE_ENTRIES]).toEqual([128, 16, 200_000, 128]);
    const objects = Array.from({ length: 128 }, (_, i) => object(`o${i}`, { kind: "box", width: .1, height: .1, depth: .1 + i * 1e-4 }, { clipId: `c${i % 16}` }, pose([(i % 16 - 7.5) * .2, (Math.floor(i / 16) - 3.5) * .2, 0])));
    const s = scene(objects), textures = new Map(Array.from({ length: 16 }, (_, i) => [`c${i}`, checker(8, 2, false)]));
    const f = render(s, textures);
    expect(f.triangleCount).toBe(128 * 12);
    textures.set("c16", checker(8, 2, false));
    expect(() => render(s, textures)).toThrow("預算");
    const segment = s.segments[0], cache = cacheFor(s), draws = [...segment.objects, segment.objects[0]].map(o => ({ object: o, time: 0, mesh: cache.get(o.geometry) }));
    expect(() => rasterizeMesh3d(s, segment.camera, draws, W, H)).toThrow("預算");
    const big = { positions: new Float32Array(9), normals: new Float32Array(9), uvs: new Float32Array(6), indices: new Uint32Array((MESH3D_MAX_SCENE_TRIANGLES + 1) * 3) };
    expect(() => rasterizeMesh3d(s, segment.camera, [{ object: objects[0], time: 0, mesh: big }], W, H)).toThrow("預算");
  });
  it("new material flags on a legacy scene do not change its bytes until they take effect", () => {
    const legacy = scene([object("a", { kind: "box", width: 1, height: .8, depth: .6 }, {}, pose([0, .2, 0], [20, 30, 5])), floor()]);
    const flagged = mesh3dSceneSchema.parse({ ...legacy, segments: legacy.segments.map(s => ({ ...s, camera: { ...s.camera, roll: 0 }, objects: s.objects.map(o => ({ ...o, material: { ...o.material, castShadow: true, receiveShadow: true } })) })) });
    const a = render(legacy), b = render(flagged);
    expect(Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba))).toBe(0);
    expect(Buffer.compare(Buffer.from(a.depth.buffer), Buffer.from(b.depth.buffer))).toBe(0);
  });
});
