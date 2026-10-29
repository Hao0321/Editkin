import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Mesh3dGeometryCache, mesh3dSceneTextFaceIdsV1, parseMesh3dFont, MESH3D_TEXT_TRIANGLE_LIMIT } from "./mesh3dGeometry";
import { renderMesh3dFrame, type Mesh3dFrame, type Mesh3dTexture } from "./mesh3dRasterizer";
import { mesh3dGeometrySchema, mesh3dMaterialSchema, mesh3dObjectSchema, mesh3dPoseAt, mesh3dPostSchema, mesh3dSceneSchema, type Mesh3dObject, type Mesh3dScene } from "./mesh3dScene";
import { mesh3dBounceKeyframesV1, mesh3dOrbitKeyframesV1 } from "./mesh3dAnimation";
import { mesh3dGroupContours, mesh3dSafeBevelSize, mesh3dSignedArea } from "./mesh3dExtrude";
import { mesh3dTextFaceIdV1 } from "./mesh3dTextFaces";

const FONT_ROOT = join(import.meta.dirname, "../../public/fonts/render");
const faceCache = new Map<string, ReturnType<typeof parseMesh3dFont>>();
const face = (id: string) => { let f = faceCache.get(id); if (!f) { const b = readFileSync(join(FONT_ROOT, `${id}.ttf`)); f = parseMesh3dFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); faceCache.set(id, f); } return f; };
const cacheFor = (scene: Mesh3dScene) => new Mesh3dGeometryCache(new Map(), new Map(mesh3dSceneTextFaceIdsV1(scene).map(id => [id, face(id)])));
type V = [number, number, number];
const pose = (position: V = [0, 0, 0], rotationDegrees: V = [0, 0, 0], scale: V = [1, 1, 1]) => ({ position, rotationDegrees, scale });
const object = (id: string, geometry: Mesh3dObject["geometry"], material: Partial<Mesh3dObject["material"]> = {}, at = pose()): Mesh3dObject =>
  ({ id, name: id, geometry, pose: at, keyframes: [], material: { color: "#E04080", unlit: false, ...material } });
function scene(objects: Mesh3dObject[], extra: Partial<Mesh3dScene> = {}): Mesh3dScene {
  return mesh3dSceneSchema.parse({ schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#101020", gridColor: "#303050", spacing: 72, grid: false },
    light: { direction: [-.5, .8, .9], ambient: .35, intensity: .8 },
    segments: [{ id: "s", name: "s", timelineStart: 0, duration: 2, camera: { position: [0, .4, 4], target: [0, 0, 0], verticalFovDegrees: 50, near: .1, far: 30 }, cameraKeyframes: [], objects }], ...extra });
}
const sha = (frame: Mesh3dFrame) => createHash("sha256").update(frame.rgba).digest("hex").slice(0, 20);
const lum = (f: Mesh3dFrame, w: number, x: number, y: number) => { const p = (y * w + x) * 4; return .2126 * f.rgba[p] + .7152 * f.rgba[p + 1] + .0722 * f.rgba[p + 2]; };
const W = 96, H = 128;

describe("mesh3d extension schema", () => {
  const good: Record<string, unknown> = {
    cone: { kind: "cone", radius: .5, height: 1, segments: 24 },
    cylinder: { kind: "cylinder", radiusTop: .4, radiusBottom: .5, height: 1, segments: 32, openEnded: true },
    star: { kind: "star", points: 5, outerRadius: .6, innerRadius: .28, depth: .2, bevel: .04, bevelSegments: 3 },
    rounded_box: { kind: "rounded_box", width: 1, height: .6, depth: .4, radius: .08, segments: 3 },
    text_extrude: { kind: "text_extrude", text: "YOU", font: "display", weight: 900, size: 1, depth: .3, bevelSize: .03, bevelThickness: .04, bevelSegments: 4, tracking: 0 },
    band_text: { kind: "band_text", text: "SOMEONE", font: "latin", weight: 400, form: "cylinder", facing: "outside", radius: 1, height: .3, segments: 64, repeat: 2, tracking: .05 },
  };
  const bad: [string, unknown][] = [
    ["cone segments", { ...good.cone as object, segments: 4 }],
    ["cylinder zero radius", { ...good.cylinder as object, radiusTop: 0 }],
    ["cylinder missing openEnded", { kind: "cylinder", radiusTop: .4, radiusBottom: .5, height: 1, segments: 32 }],
    ["star inner >= outer", { ...good.star as object, innerRadius: .6 }],
    ["star bevel too deep", { ...good.star as object, bevel: .11 }],
    ["rounded_box radius", { ...good.rounded_box as object, radius: .21 }],
    ["text weight missing in face", { ...good.text_extrude as object, font: "latin", weight: 700 }],
    ["text bevel width", { ...good.text_extrude as object, bevelSize: .09 }],
    ["text bevel depth", { ...good.text_extrude as object, bevelThickness: .15 }],
    ["text empty", { ...good.text_extrude as object, text: "   " }],
    ["text font role", { ...good.text_extrude as object, font: "comic" }],
    ["band torus too tall", { ...good.band_text as object, form: "torus", height: 2.2 }],
    ["band repeat", { ...good.band_text as object, repeat: 0 }],
    ["band facing", { ...good.band_text as object, facing: "both" }],
  ];
  it("accepts every new geometry kind", () => { for (const [kind, value] of Object.entries(good)) expect(mesh3dGeometrySchema.safeParse(value).success, kind).toBe(true); });
  it.each(bad)("rejects %s", (_, value) => { expect(mesh3dGeometrySchema.safeParse(value).success).toBe(false); });
  const base = { color: "#FFFFFF", unlit: false };
  const materials: [string, object, boolean][] = [
    ["emissive", { emissive: { color: "#FF00AA", strength: 2 } }, true], ["emissive too strong", { emissive: { color: "#FF00AA", strength: 20 } }, false],
    ["stripes", { stripes: { colors: ["#FFFFFF", "#FF0088"], count: 12, angleDegrees: 0 } }, true], ["stripes zero", { stripes: { colors: ["#FFFFFF", "#FF0088"], count: 0, angleDegrees: 0 } }, false],
    ["stripes with clip", { clipId: "c", stripes: { colors: ["#FFFFFF", "#FF0088"], count: 4, angleDegrees: 0 } }, false],
    ["gradient", { gradient: { colors: ["#000000", "#FFFFFF"], axis: "y" } }, true], ["gradient axis", { gradient: { colors: ["#000000", "#FFFFFF"], axis: "w" } }, false],
    ["gradient with stripes", { gradient: { colors: ["#000000", "#FFFFFF"], axis: "y" }, stripes: { colors: ["#FFFFFF", "#FF0088"], count: 4, angleDegrees: 0 } }, false],
    ["edgeLight", { edgeLight: { color: "#F868A8", strength: 1, power: 3 } }, true], ["edgeLight power", { edgeLight: { color: "#F868A8", strength: 1, power: .1 } }, false],
    ["specular", { specular: { strength: 1, shininess: 64 } }, true], ["specular shininess", { specular: { strength: 1, shininess: 0 } }, false],
    ["reflection", { reflection: { strength: .5, sky: "#FFFFFF", horizon: "#FFFFFF", ground: "#000000" } }, true], ["reflection strength", { reflection: { strength: 2, sky: "#FFFFFF", horizon: "#FFFFFF", ground: "#000000" } }, false],
    ["wireframe", { wireframe: { color: "#F868A8", width: 1.5, divisions: [16, 8], fill: false } }, true], ["wireframe divisions", { wireframe: { color: "#F868A8", width: 1.5, divisions: [0, 8], fill: false } }, false],
    ["grid with wireframe", { grid: true, wireframe: { color: "#F868A8", width: 1.5, divisions: [16, 8], fill: true } }, false],
    ["unknown field", { glow: 1 }, false],
  ];
  it.each(materials)("material %s", (_, extra, ok) => { expect(mesh3dMaterialSchema.safeParse({ ...base, ...extra }).success).toBe(ok); });
  it("keeps the original material shape valid and untouched", () => {
    const legacy = { color: "#FFFFFF", unlit: true, clipId: "clip", grid: false, doubleSided: true };
    expect(mesh3dMaterialSchema.parse(legacy)).toEqual(legacy);
  });
  it("validates lights, background glow, post effects and easings", () => {
    const s = scene([object("a", { kind: "box", width: 1, height: 1, depth: 1 })]);
    const parse = (patch: object) => mesh3dSceneSchema.safeParse({ ...s, ...patch }).success;
    expect(parse({ light: { ...s.light, fill: { direction: [1, 0, 0], intensity: .5, color: "#F868A8" }, hemisphere: { sky: "#FFFFFF", ground: "#000000", intensity: .3 } } })).toBe(true);
    expect(parse({ light: { ...s.light, fill: { direction: [1, 0, 0], intensity: .5, color: "pink" } } })).toBe(false);
    expect(parse({ light: { ...s.light, hemisphere: { sky: "#FFFFFF", ground: "#000000", intensity: 3 } } })).toBe(false);
    expect(parse({ background: { ...s.background, radial: { color: "#8A1A4C", center: [.5, .4], radius: .5, strength: .8 } } })).toBe(true);
    expect(parse({ background: { ...s.background, radial: { color: "#8A1A4C", center: [2, .4], radius: .5, strength: .8 } } })).toBe(false);
    const post = { bloom: { threshold: .8, strength: 1, radius: .05 }, dof: { focusDistance: 4, aperture: .01 }, motionBlur: { shutterSeconds: 1 / 60, samples: 6 }, fisheye: { strength: .4 }, vignette: { strength: .5, softness: .5 } };
    expect(mesh3dPostSchema.safeParse(post).success).toBe(true);
    for (const wrong of [{ motionBlur: { shutterSeconds: 1 / 60, samples: 1 } }, { motionBlur: { shutterSeconds: 0, samples: 4 } }, { fisheye: { strength: 2 } }, { dof: { focusDistance: 4, aperture: .2 } }, { lensFlare: {} }])
      expect(mesh3dPostSchema.safeParse(wrong).success).toBe(false);
    const keyed = { ...object("k", { kind: "box", width: 1, height: 1, depth: 1 }), keyframes: [{ time: 1, pose: pose([0, 1, 0]), easing: "easeIn" }] };
    expect(mesh3dObjectSchema.safeParse(keyed).success).toBe(true);
    expect(mesh3dObjectSchema.safeParse({ ...keyed, keyframes: [{ ...keyed.keyframes[0], easing: "bounce" }] }).success).toBe(false);
  });
  it("samples quadratic easings exactly", () => {
    const o = { ...object("k", { kind: "box", width: 1, height: 1, depth: 1 }), keyframes: [{ time: 2, pose: pose([0, 4, 0]), easing: "easeIn" as const }] };
    expect(mesh3dPoseAt(o, .5).position[1]).toBeCloseTo(4 * .0625, 12);
    o.keyframes[0].easing = "easeOut" as never;
    expect(mesh3dPoseAt(o, .5).position[1]).toBeCloseTo(4 * (1 - .75 * .75), 12);
  });
});

describe("glyph extrusion (real bundled faces)", () => {
  const build = (text: string, font: "display" | "latin" | "serif", weight: number, bevelSize = .03) => {
    const geometry = mesh3dGeometrySchema.parse({ kind: "text_extrude", text, font, weight, size: 1, depth: .3, bevelSize, bevelThickness: .04, bevelSegments: 4, tracking: 0 });
    return new Mesh3dGeometryCache(new Map(), new Map([[mesh3dTextFaceIdV1(font, weight), face(mesh3dTextFaceIdV1(font, weight))]])).get(geometry);
  };
  const bounds = (positions: Float32Array) => { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], positions[i + k]); b[k + 3] = Math.max(b[k + 3], positions[i + k]); } return b; };
  it.each([["YOU", "display", 900, 800, 6000], ["YOU", "latin", 400, 300, 4000], ["動態歌詞", "display", 900, 2500, MESH3D_TEXT_TRIANGLE_LIMIT], ["品牌", "serif", 700, 1200, MESH3D_TEXT_TRIANGLE_LIMIT]] as const)(
    "%s (%s %d) has a bounded mesh with flat caps, unit normals and true depth", (text, font, weight, low, high) => {
      const mesh = build(text, font, weight), triangles = mesh.indices.length / 3, b = bounds(mesh.positions);
      expect(triangles).toBeGreaterThan(low); expect(triangles).toBeLessThan(high);
      expect(b[5] - b[2]).toBeCloseTo(.3, 5); expect(Math.abs(b[0] + b[3])).toBeLessThan(1e-4); expect(Math.abs(b[1] + b[4])).toBeLessThan(1e-4);
      let caps = 0;
      for (let i = 0; i < mesh.normals.length; i += 3) {
        const n = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
        expect(n).toBeCloseTo(1, 5);
        if (Math.abs(mesh.normals[i + 2]) > .9999 && Math.abs(Math.abs(mesh.positions[i + 2]) - .15) < 1e-5) caps++;
      }
      expect(caps).toBeGreaterThan(20);
      for (const index of mesh.indices) expect(index).toBeLessThan(mesh.positions.length / 3);
    });
  it("refuses a glyph the face does not have instead of drawing a box", () => {
    expect(() => build("你", "latin", 400)).toThrow("缺少");
  });
  it("needs the face loaded and names it", () => {
    const geometry = mesh3dGeometrySchema.parse({ kind: "text_extrude", text: "A", font: "display", weight: 700, size: 1, depth: .3, bevelSize: 0, bevelThickness: 0, bevelSegments: 1, tracking: 0 });
    expect(() => new Mesh3dGeometryCache().get(geometry)).toThrow("EditkinFace-noto-sans-tc-700");
  });
  it("shrinks a bevel that would invert thin strokes, once for the whole word", () => {
    // A 0.08-wide stem: insetting 0.06 from both sides would cross, 0.01 is fine.
    const shapes = mesh3dGroupContours([[0, 0, .08, 0, .08, .7, 0, .7]], 1e-4);
    expect(mesh3dSignedArea(shapes[0].outer)).toBeLessThan(0);
    expect(mesh3dSafeBevelSize(shapes, .01)).toBe(.01);
    expect(mesh3dSafeBevelSize(shapes, .06)).toBeLessThan(.04);
  });
  it("lists the faces a scene needs", () => {
    const s = scene([object("t", mesh3dGeometrySchema.parse({ kind: "text_extrude", text: "A", font: "display", weight: 900, size: 1, depth: .3, bevelSize: 0, bevelThickness: 0, bevelSegments: 1, tracking: 0 })),
      object("b", mesh3dGeometrySchema.parse({ kind: "band_text", text: "B", font: "latin", weight: 400, form: "cylinder", facing: "outside", radius: 1, height: .3, segments: 32, repeat: 1, tracking: 0 }))]);
    expect(mesh3dSceneTextFaceIdsV1(s)).toEqual(["EditkinFace-bebas-neue-400", "EditkinFace-noto-sans-tc-900"]);
  });
  it("builds a band text mask with real coverage and mip levels", () => {
    const geometry = mesh3dGeometrySchema.parse({ kind: "band_text", text: "SOMEONE", font: "latin", weight: 400, form: "torus", facing: "outside", radius: 1, height: .3, segments: 48, repeat: 2, tracking: .05 });
    const mesh = new Mesh3dGeometryCache(new Map(), new Map([["EditkinFace-bebas-neue-400", face("EditkinFace-bebas-neue-400")]])).get(geometry);
    expect(mesh.mask!.levels.length).toBeGreaterThan(2);
    const level = mesh.mask!.levels[0], covered = level.alpha.reduce((n, a) => n + Number(a > 200), 0);
    expect(covered / level.alpha.length).toBeGreaterThan(.08); expect(covered / level.alpha.length).toBeLessThan(.6);
    expect(mesh.mask!.repeat).toBe(2);
  });
});

describe("pose generators compile to ordinary keyframes", () => {
  it("bounce: parabolic segments, decaying peaks, squash on the floor, valid object", () => {
    const track = mesh3dBounceKeyframesV1({ start: pose([0, 3, 0]), floorY: 0, contactOffset: .5, restitution: .6, bounces: 4, squash: .2, startTime: .25, drift: [1, 0], spinDegrees: [0, 90, 0], until: 10 });
    expect(track.keyframes.length).toBeLessThanOrEqual(16);
    expect(track.keyframes.map(k => k.time)).toEqual([...track.keyframes.map(k => k.time)].sort((a, b) => a - b));
    expect(new Set(track.keyframes.map(k => k.time)).size).toBe(track.keyframes.length);
    const impacts = track.keyframes.filter(k => k.easing === "easeIn"), peaks = track.keyframes.filter(k => k.easing === "easeOut");
    expect(impacts).toHaveLength(5); expect(peaks).toHaveLength(4);
    for (const k of impacts) { expect(k.pose.position[1]).toBeCloseTo(.5 * .8, 6); expect(k.pose.scale[1]).toBeCloseTo(.8, 6); }
    const heights = peaks.map(k => k.pose.position[1] - .5);
    expect(heights[0]).toBeCloseTo(2.5 * .36, 5);
    for (let i = 1; i < heights.length; i++) expect(heights[i] / heights[i - 1]).toBeCloseTo(.36, 5);
    expect(track.keyframes.at(-1)!.pose.position[0]).toBeCloseTo(1, 6);
    expect(mesh3dObjectSchema.safeParse({ ...object("ball", { kind: "sphere", radius: .5, segments: 16 }), pose: track.pose, keyframes: track.keyframes }).success).toBe(true);
    // Free fall: halfway through the first drop the ball has fallen a quarter of the height.
    const firstImpact = impacts[0].time, ball = { ...object("ball", { kind: "sphere", radius: .5, segments: 16 }), pose: track.pose, keyframes: track.keyframes };
    expect(mesh3dPoseAt(ball, .25 + (firstImpact - .25) / 2).position[1]).toBeCloseTo(3 - (3 - .4) / 4, 5);
  });
  it("bounce: drops keys after the segment and rejects impossible input", () => {
    expect(mesh3dBounceKeyframesV1({ start: pose([0, 3, 0]), floorY: 0, contactOffset: .5, restitution: .6, bounces: 4, until: .9 }).keyframes.every(k => k.time <= .9)).toBe(true);
    expect(() => mesh3dBounceKeyframesV1({ start: pose([0, .2, 0]), floorY: 0, contactOffset: .5, restitution: .6, bounces: 2 })).toThrow("ABOVE_FLOOR");
    expect(() => mesh3dBounceKeyframesV1({ start: pose([0, 3, 0]), floorY: 0, contactOffset: .5, restitution: .99, bounces: 2 })).toThrow("INVALID");
    expect(() => mesh3dBounceKeyframesV1({ start: pose([0, 3, 0]), floorY: 0, contactOffset: .5, restitution: .5, bounces: 5 })).toThrow("INVALID");
  });
  it("orbit: points on the circle, linear keys, reported chord sag", () => {
    const track = mesh3dOrbitKeyframesV1({ center: [1, 2, 3], radius: 2, startDegrees: 0, endDegrees: 360, startTime: 0, endTime: 4, keyframes: 16, faceTravel: true });
    expect(track.keyframes).toHaveLength(16);
    for (const k of [track.pose, ...track.keyframes.map(k => k.pose)]) expect(Math.hypot(k.position[0] - 1, k.position[2] - 3)).toBeCloseTo(2, 5);
    expect(track.keyframes.every(k => k.easing === "linear" && k.pose.position[1] === 2)).toBe(true);
    expect(track.keyframes.at(-1)!.pose.rotationDegrees[1]).toBeCloseTo(360, 6);
    expect(track.maxRadialError).toBeCloseTo(2 * (1 - Math.cos(Math.PI / 16)), 9);
    const held = mesh3dOrbitKeyframesV1({ center: [0, 0, 0], radius: 1, axis: "z", startDegrees: 90, endDegrees: 180, startTime: 1, endTime: 2, keyframes: 4 });
    expect(held.keyframes[0]).toMatchObject({ time: 1 }); expect(held.pose.position[1]).toBeCloseTo(1, 9);
    expect(() => mesh3dOrbitKeyframesV1({ center: [0, 0, 0], radius: 1, startDegrees: 0, endDegrees: 90, startTime: 0, endTime: 1, keyframes: 17 })).toThrow("INVALID");
  });
});

/** Golden pixel hashes (96×128) of each new geometry, material and post effect, captured from this implementation. */
function goldenScenes(): Record<string, { scene: Mesh3dScene; time?: number; textures?: Map<string, Mesh3dTexture> }> {
  const g = (geometry: object) => mesh3dGeometrySchema.parse(geometry);
  const lit = { specular: { strength: .6, shininess: 48 } };
  const out: Record<string, { scene: Mesh3dScene; time?: number; textures?: Map<string, Mesh3dTexture> }> = {
    "geometry:cone": { scene: scene([object("a", g({ kind: "cone", radius: .8, height: 1.4, segments: 32 }))]) },
    "geometry:cylinder": { scene: scene([object("a", g({ kind: "cylinder", radiusTop: .6, radiusBottom: .8, height: 1.4, segments: 32, openEnded: true }), { doubleSided: true }, pose([0, 0, 0], [20, 0, 0]))]) },
    "geometry:star": { scene: scene([object("a", g({ kind: "star", points: 5, outerRadius: 1, innerRadius: .45, depth: .3, bevel: .06, bevelSegments: 3 }), {}, pose([0, 0, 0], [10, -25, 0]))]) },
    "geometry:rounded_box": { scene: scene([object("a", g({ kind: "rounded_box", width: 1.4, height: 1, depth: .6, radius: .15, segments: 3 }), {}, pose([0, 0, 0], [15, 30, 0]))]) },
    "geometry:text_extrude": { scene: scene([object("a", g({ kind: "text_extrude", text: "YOU", font: "display", weight: 900, size: .9, depth: .3, bevelSize: .03, bevelThickness: .04, bevelSegments: 3, tracking: 0 }), lit, pose([0, 0, 0], [8, -20, 0]))]) },
    "geometry:text_extrude_cjk": { scene: scene([object("a", g({ kind: "text_extrude", text: "歌詞", font: "display", weight: 900, size: .9, depth: .25, bevelSize: .02, bevelThickness: .03, bevelSegments: 2, tracking: 0 }), lit, pose([0, 0, 0], [8, -20, 0]))]) },
    "geometry:band_text": { scene: scene([object("a", g({ kind: "band_text", text: "KNOWS", font: "latin", weight: 400, form: "cylinder", facing: "outside", radius: 1, height: .5, segments: 64, repeat: 2, tracking: .05 }), { unlit: true, color: "#FFE0F0" })]) },
    "material:emissive": { scene: scene([object("a", g({ kind: "sphere", radius: .9, segments: 24 }), { emissive: { color: "#FF3399", strength: .6 } })]) },
    "material:stripes": { scene: scene([object("a", g({ kind: "torus", radius: .8, tube: .3, segments: 48 }), { stripes: { colors: ["#FFFFFF", "#F868A8"], count: 10, angleDegrees: 0 } }, pose([0, 0, 0], [60, 0, 0]))]) },
    "material:gradient": { scene: scene([object("a", g({ kind: "box", width: 1.2, height: 1.4, depth: .4 }), { gradient: { colors: ["#200040", "#FFD0E8"], axis: "y" } }, pose([0, 0, 0], [10, 25, 0]))]) },
    "material:edgeLight": { scene: scene([object("a", g({ kind: "sphere", radius: .9, segments: 24 }), { color: "#301020", edgeLight: { color: "#F868A8", strength: 1.2, power: 2.5 } })]) },
    "material:specular": { scene: scene([object("a", g({ kind: "sphere", radius: .9, segments: 24 }), { specular: { strength: 1, shininess: 64 } })]) },
    "material:reflection": { scene: scene([object("a", g({ kind: "sphere", radius: .9, segments: 24 }), { color: "#808080", reflection: { strength: .8, sky: "#AFC4FF", horizon: "#FFFFFF", ground: "#081236" } })]) },
    "material:wireframe": { scene: scene([object("a", g({ kind: "sphere", radius: 1.1, segments: 32 }), { wireframe: { color: "#F868A8", width: 9, divisions: [16, 8], fill: false }, doubleSided: true })]) },
    "material:wireframe_fill": { scene: scene([object("a", g({ kind: "box", width: 3, height: .05, depth: 3 }), { color: "#300818", wireframe: { color: "#F868A8", width: 1, divisions: [12, 12], fill: true } }, pose([0, -.6, 0]))]) },
    "light:fill+hemisphere": { scene: scene([object("a", g({ kind: "sphere", radius: .9, segments: 24 }), { color: "#FFFFFF" })], { light: { direction: [-.5, .8, .9], ambient: .2, intensity: .6, fill: { direction: [1, 0, -.3], intensity: .9, color: "#F868A8" }, hemisphere: { sky: "#FFFFFF", ground: "#480818", intensity: .3 } } }) },
    "background:radial": { scene: scene([object("a", g({ kind: "cone", radius: .4, height: .8, segments: 16 }))], { background: { color: "#480818", gridColor: "#000000", spacing: 72, grid: false, radial: { color: "#C04080", center: [.5, .4], radius: .5, strength: .8 } } }) },
  };
  const bright = object("glow", g({ kind: "sphere", radius: .35, segments: 24 }), { unlit: true, color: "#FFFFFF", emissive: { color: "#FF66AA", strength: 1.5 } });
  const far = object("far", g({ kind: "box", width: 1.6, height: 1.6, depth: .2 }), { stripes: { colors: ["#FFFFFF", "#202040"], count: 8, angleDegrees: 0 } }, pose([-1.5, 1.2, -6]));
  const near = object("near", g({ kind: "box", width: .8, height: .8, depth: .8 }), { color: "#40C0FF" }, pose([0, 0, 1.4]));
  out["post:bloom"] = { scene: scene([bright], { post: { bloom: { threshold: .7, strength: 1.2, radius: .08 } } }) };
  out["post:dof"] = { scene: scene([far, near], { post: { dof: { focusDistance: 2.6, aperture: .03 } } }) };
  out["post:fisheye"] = { scene: scene([object("grid", g({ kind: "box", width: 6, height: 6, depth: .05 }), { wireframe: { color: "#FFFFFF", width: 1.5, divisions: [12, 12], fill: true } }, pose([0, 0, -1]))], { post: { fisheye: { strength: .6 } } }) };
  out["post:vignette"] = { scene: scene([bright], { post: { vignette: { strength: .8, softness: .6 } } }) };
  const mover = { ...object("mover", g({ kind: "box", width: .4, height: .4, depth: .4 }), { color: "#FFFFFF", unlit: true }), keyframes: [{ time: 2, pose: pose([4, 0, 0]), easing: "linear" as const }], pose: pose([-4, 0, 0]) };
  out["post:motionBlur"] = { scene: scene([mover], { post: { motionBlur: { shutterSeconds: .1, samples: 8 } } }), time: 1 };
  return out;
}
const GOLDEN: Record<string, string> = {
  "geometry:cone": "5974cc19b6fad2b4f896",
  "geometry:cylinder": "aafcd46222028e6b55d6",
  "geometry:star": "fb9657e965a11c013427",
  "geometry:rounded_box": "91e7273495b9a6917ba6",
  "geometry:text_extrude": "89a3d2041b4eb8ad1802",
  "geometry:text_extrude_cjk": "f9b3c31e1249094966c6",
  "geometry:band_text": "5cd48ce16fe5a0ba0db2",
  "material:emissive": "dcf573483c61bc2c7fd2",
  "material:stripes": "5a8678b2005aee0d657b",
  "material:gradient": "659211da90916edaf870",
  "material:edgeLight": "2799e8ffdf6bf95328d5",
  "material:specular": "44c80c295413970ac058",
  "material:reflection": "f803d0bb2d92662df915",
  "material:wireframe": "cbe9c8cb19f276d40f88",
  "material:wireframe_fill": "a78dac1e0ec2ac359653",
  "light:fill+hemisphere": "fd3db2d01c004d786c51",
  "background:radial": "d1975116bdc4592f6618",
  "post:bloom": "f1d4788dfdb90da9e649",
  "post:dof": "81feed9179e3e2dfae5b",
  "post:fisheye": "c096d4561baaca9dcbc8",
  "post:vignette": "4b808ce1308c4ac6fe75",
  "post:motionBlur": "2ffe0ab432ecc13ca233",
};

describe("golden renders of new geometry, materials and post effects", () => {
  it("match the captured hashes", () => {
    const actual: Record<string, string> = {};
    for (const [name, { scene: s, time, textures }] of Object.entries(goldenScenes())) actual[name] = sha(renderMesh3dFrame(s, time ?? .5, W, H, cacheFor(s), textures));
    if (process.env.MESH3D_CAPTURE_GOLDEN) { console.log(JSON.stringify(actual, null, 2)); return; }
    expect(Object.keys(GOLDEN)).toHaveLength(Object.keys(actual).length);
    expect(actual).toEqual(GOLDEN);
  }, 120_000);
  it("each effect does what it says (semantic pixel checks)", () => {
    const all = goldenScenes(), r = (name: string) => { const g = all[name]; return renderMesh3dFrame(g.scene, g.time ?? .5, W, H, cacheFor(g.scene), g.textures); };
    const without = (name: string, patch: object) => { const g = all[name], s = mesh3dSceneSchema.parse({ ...g.scene, ...patch }); return renderMesh3dFrame(s, g.time ?? .5, W, H, cacheFor(s)); };
    // Bloom lights pixels outside the bright sphere.
    const bloom = r("post:bloom"), plain = without("post:bloom", { post: { vignette: { strength: 0, softness: .5 } } });
    expect(lum(bloom, W, 48, 46)).toBeGreaterThan(lum(plain, W, 48, 46) + 4);
    // DOF: the far stripes lose contrast while the near box stays sharp-edged.
    const dof = r("post:dof"), sharp = without("post:dof", { post: { vignette: { strength: 0, softness: .5 } } });
    const contrast = (f: Mesh3dFrame) => { let lo = 255, hi = 0; for (let x = 18; x < 38; x++) { const v = lum(f, W, x, 48); lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
    expect(contrast(dof)).toBeLessThan(contrast(sharp) * .8);
    // Vignette darkens corners and keeps the centre.
    const vignette = r("post:vignette"), open = without("post:vignette", { post: { bloom: { threshold: 4, strength: 0, radius: .05 } } });
    expect(lum(vignette, W, 1, 1)).toBeLessThan(lum(open, W, 1, 1)); expect(Math.abs(lum(vignette, W, 48, 64) - lum(open, W, 48, 64))).toBeLessThan(2);
    // Motion blur spreads the moving box: more partially covered pixels than a single sample.
    const blurred = r("post:motionBlur"), single = without("post:motionBlur", { post: { vignette: { strength: 0, softness: .5 } } });
    const partial = (f: Mesh3dFrame) => { let n = 0; for (let x = 0; x < W; x++) { const v = lum(f, W, x, 64); if (v > 40 && v < 200) n++; } return n; };
    expect(partial(blurred)).toBeGreaterThan(partial(single) + 6);
    // Emission brightens; stripes alternate; the line-only wireframe leaves the background visible between lines.
    const emissive = r("material:emissive"), dull = without("material:emissive", { segments: all["material:emissive"].scene.segments.map(s => ({ ...s, objects: s.objects.map(o => ({ ...o, material: { color: o.material.color, unlit: false } })) })) });
    expect(lum(emissive, W, 48, 64)).toBeGreaterThan(lum(dull, W, 48, 64) + 20);
    const wire = r("material:wireframe"), background = lum(wire, W, 0, 0);
    let hits = 0, gaps = 0; for (let x = 20; x < 76; x++) { const v = lum(wire, W, x, 64); if (v > background + 40) hits++; else if (Math.abs(v - background) < 3) gaps++; }
    expect(hits).toBeGreaterThan(3); expect(gaps).toBeGreaterThan(10);
  }, 120_000);
  it("refuses distortion effects on scenes with world-anchored overlays", () => {
    const s = goldenScenes()["post:fisheye"].scene;
    s.overlaysV1 = { schema: "editkin.mesh-overlays/v1", anchors: [{ id: "a", segmentId: "s", objectId: "grid", localPoint: [0, 0, 0] }],
      layers: [{ id: "l", anchorId: "a", clipId: "c", size: [.1, .1], offset: [0, 0], pivot: [.5, .5], opacity: 1, occlusion: "always_front" }] };
    expect(() => renderMesh3dFrame(s, .5, W, H, cacheFor(s))).toThrow("MESH_POST_DISTORTION_WITH_OVERLAYS_UNSUPPORTED");
  });
});
