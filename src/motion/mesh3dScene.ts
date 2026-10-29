import { z } from "zod";
import { mesh3dOverlaysV1Schema } from "./mesh3dOverlayV1";
import { MESH3D_TEXT_FONT_ROLES, mesh3dTextWeightAvailableV1, type Mesh3dTextFontRole } from "./mesh3dTextFaces";

const finite = z.number().finite();
const vector = z.tuple([finite.min(-100).max(100), finite.min(-100).max(100), finite.min(-100).max(100)]);
const rotation = z.tuple([finite.min(-360000).max(360000), finite.min(-360000).max(360000), finite.min(-360000).max(360000)]);
const size = finite.positive().max(20);
const color = z.string().regex(/^#[a-f\d]{6}$/i);
const pose = z.strictObject({ position: vector, rotationDegrees: rotation, scale: z.tuple([size, size, size]) });
const camera = z.strictObject({ position: vector, target: vector, verticalFovDegrees: finite.min(15).max(100), near: finite.min(.01).max(2), far: finite.min(2).max(200),
  /** Polish 2026-10-23: degrees about the line of sight; positive rolls the camera counter-clockwise (the image turns clockwise). */
  roll: finite.min(-3600).max(3600).optional() });
// Engine extension (2026-10-23). Every field below is optional or a new geometry
// kind: a scene that uses none of them parses and renders exactly as before.
const unit = finite.min(0).max(1);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const fontRole = z.enum(MESH3D_TEXT_FONT_ROLES);
const colorPair = z.tuple([color, color]);
const faceIssue = { message: "3D 文字字重不存在於內建字型（不合成、不替換）", path: ["weight"] };
const faceAvailable = (value: { font: Mesh3dTextFontRole; weight: number }) => mesh3dTextWeightAvailableV1(value.font, value.weight);
/** Keyframe easings. easeIn/easeOut are quadratic: free fall and rise are exact parabolas (bounce helper). */
export const MESH3D_EASINGS = ["linear", "smooth", "hold", "easeIn", "easeOut"] as const;
const easing = z.enum(MESH3D_EASINGS);
/** A reveal window [start, end] of arc length (fractions, start ≤ end); a number n means [0, n]. */
const tubeReveal = z.union([unit, z.tuple([unit, unit]).refine(w => w[0] <= w[1], { message: "管線顯示區間需開始不晚於結束" })]);
/**
 * tube_set polyline (2026-10-29): points in object space, radius per polyline or per vertex (0 allowed on a vertex, so a
 * branch can taper to a point), `closed` reserved (open only), `reveal` the shown arc-length window (default [0, 1];
 * keyframed by revealKeyframes, segment-local time like object keyframes), `growthSpan` the part of the object's
 * growth (0..1) over which the window draws on from its start (default [0, 1]).
 */
const tubePolyline = z.strictObject({
  points: z.array(vector).min(2).max(4096),
  radius: z.union([finite.positive().max(20), z.array(finite.min(0).max(20)).min(2).max(4096)]),
  closed: z.literal(false).optional(),
  reveal: tubeReveal.optional(),
  revealKeyframes: z.array(z.strictObject({ time: finite.nonnegative(), reveal: tubeReveal, easing })).max(16).optional(),
  growthSpan: z.tuple([unit, unit]).optional(),
}).refine(p => typeof p.radius === "number" || (p.radius.length === p.points.length && p.radius.some(r => r > 0)), { message: "管線逐點半徑需與點數相同，且不可全為 0", path: ["radius"] })
  .refine(p => p.points.every((q, i) => i === 0 || Math.hypot(q[0] - p.points[i - 1][0], q[1] - p.points[i - 1][1], q[2] - p.points[i - 1][2]) > 1e-6), { message: "管線相鄰點不可重合", path: ["points"] })
  .refine(p => !p.growthSpan || p.growthSpan[0] < p.growthSpan[1], { message: "管線生長區間需開始早於結束", path: ["growthSpan"] });
/** Colour role name of tube_set tips (resolved by the geometry's tipColors). */
const tubeTipRole = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
/**
 * tube_set tip (2026-10-29): a small mesh on polyline `polylineIndex` at arc-length fraction `at` (or its "end"):
 * "sphere" (bud), "petal" (five-petal blossom), "star", "leaf"; +Y along the tangent, `scale` its size in object
 * units, `tilt` (degrees, toward the frame normal) and `spin` (degrees about the tangent) optional. It shows once its
 * anchor is drawn and the object's growth has passed `revealAt` (default 0), growing in over 0.05 of growth.
 */
const tubeTip = z.strictObject({ polylineIndex: integer(0, 2047), at: z.union([unit, z.literal("end")]), mesh: z.enum(["sphere", "petal", "star", "leaf"]),
  scale: finite.positive().max(5), colorRole: tubeTipRole, revealAt: unit.optional(), tilt: finite.min(-180).max(180).optional(), spin: finite.min(-360).max(360).optional() });
export const mesh3dGeometrySchema = z.discriminatedUnion("kind", [
  /** uvMode (polish): "repeat" (default) maps the texture to all six faces, "front" only to +z (other faces use the colour), "atlas" a 3×2 grid: +x −x +y over −y +z −z. */
  z.strictObject({ kind: z.literal("box"), width: size, height: size, depth: size, uvMode: z.enum(["repeat", "front", "atlas"]).optional() }),
  z.strictObject({ kind: z.literal("sphere"), radius: size, segments: z.number().int().min(8).max(64) }),
  z.strictObject({ kind: z.literal("curved_video"), radius: size, width: size, height: size, segments: z.number().int().min(4).max(64) }),
  /** tubeSegments (polish): cross-section segments, default 8. */
  z.strictObject({ kind: z.literal("torus"), radius: size, tube: finite.min(.01).max(1), segments: z.number().int().min(8).max(64), tubeSegments: integer(3, 64).optional() }),
  /** curveSegments (polish): glyph curves are flattened adaptively (chord tolerance 0.03% of the height) with at most this many segments each; omitted = the original fixed 3. */
  z.strictObject({ kind: z.literal("text"), text: z.string().trim().min(1).max(24), fontFamily: z.literal("Noto Sans TC"), fontWeight: z.union([z.literal(700), z.literal(900)]), height: finite.min(.1).max(3), depth: finite.min(.01).max(.6), bevel: finite.min(0).max(.035), curveSegments: integer(1, 32).optional() }),
  z.strictObject({ kind: z.literal("cone"), radius: size, height: size, segments: integer(8, 96) }),
  z.strictObject({ kind: z.literal("cylinder"), radiusTop: size, radiusBottom: size, height: size, segments: integer(8, 128), openEnded: z.boolean() }),
  z.strictObject({ kind: z.literal("star"), points: integer(3, 16), outerRadius: size, innerRadius: size, depth: finite.min(.01).max(4), bevel: finite.min(0).max(.5), bevelSegments: integer(1, 8) })
    .refine(v => v.innerRadius < v.outerRadius && v.bevel * 2 < v.depth && v.bevel <= v.innerRadius * .4, { message: "星形內徑需小於外徑，倒角需小於厚度一半與內徑四成" }),
  /** uvMode (polish): "planar" (default) projects the texture through the whole solid, "front" textures only front-facing parts (the rest uses the colour). */
  z.strictObject({ kind: z.literal("rounded_box"), width: size, height: size, depth: size, radius: finite.min(0).max(10), segments: integer(1, 12), uvMode: z.enum(["planar", "front"]).optional() })
    .refine(v => v.radius * 2 <= Math.min(v.width, v.height, v.depth) + 1e-9, { message: "圓角半徑不可超過最短邊的一半", path: ["radius"] }),
  z.strictObject({ kind: z.literal("text_extrude"), text: z.string().trim().min(1).max(24), font: fontRole, weight: integer(100, 900),
    size: finite.min(.05).max(8), depth: finite.min(.005).max(4), bevelSize: finite.min(0).max(.3), bevelThickness: finite.min(0).max(.5),
    bevelSegments: integer(1, 8), bevelProfile: z.enum(["round", "chamfer"]).optional(), tracking: finite.min(-.3).max(1) })
    .refine(faceAvailable, faceIssue)
    .refine(v => v.bevelSize <= v.size * .08 + 1e-9 && v.bevelThickness * 2 < v.depth, { message: "倒角寬度最多字高 8%，倒角深度需小於厚度一半", path: ["bevelSize"] }),
  z.strictObject({ kind: z.literal("band_text"), text: z.string().trim().min(1).max(48), font: fontRole, weight: integer(100, 900),
    form: z.enum(["cylinder", "torus"]), facing: z.enum(["outside", "inside"]), radius: size, height: finite.min(.02).max(10),
    segments: integer(16, 192), repeat: integer(1, 12), tracking: finite.min(-.3).max(1) })
    .refine(faceAvailable, faceIssue)
    .refine(v => v.form === "cylinder" || v.height / 2 < v.radius, { message: "環面文字帶的半高需小於半徑", path: ["height"] }),
  /**
   * tube_set (2026-10-29): many polylines swept by a circle in one object (mesh3dTubeSet.ts) — L-system branches,
   * vines, routes, wires, line charts. radialSegments around (default 8), caps "round" (default) or "flat", growth 0..1
   * (default 1) keyframed by growthKeyframes (segment-local time, like object keyframes). `tips` (at most 4096) are
   * instanced small meshes drawn with the object's material in the colour tipColors gives their role (one draw per
   * role, at most 8). At most 65,536 points; the exact triangle count, tips included (mesh3dTubeSetCountV1), is held to
   * the per-frame budget by validation and the export.
   */
  z.strictObject({ kind: z.literal("tube_set"), polylines: z.array(tubePolyline).min(1).max(2048),
    radialSegments: integer(3, 32).optional(), caps: z.enum(["round", "flat"]).optional(), growth: unit.optional(),
    growthKeyframes: z.array(z.strictObject({ time: finite.nonnegative(), growth: unit, easing })).max(16).optional(),
    tips: z.array(tubeTip).max(4096).optional(), tipColors: z.record(tubeTipRole, color).optional() })
    .refine(v => v.polylines.reduce((n, p) => n + p.points.length, 0) <= 65_536, { message: "管線總點數最多 65536", path: ["polylines"] })
    .refine(v => (v.tips ?? []).every(tip => tip.polylineIndex < v.polylines.length), { message: "管線端點裝飾指向不存在的管線", path: ["tips"] })
    .refine(v => (v.tips ?? []).every(tip => v.tipColors?.[tip.colorRole] !== undefined) && Object.keys(v.tipColors ?? {}).length <= 8,
      { message: "管線端點裝飾的顏色角色需在 tipColors（最多 8 個）", path: ["tipColors"] }),
]);
export const mesh3dMaterialSchema = z.strictObject({
  color, unlit: z.boolean(), clipId: z.string().min(1).max(160).optional(), grid: z.boolean().optional(), doubleSided: z.boolean().optional(),
  emissive: z.strictObject({ color, strength: finite.min(0).max(16) }).optional(),
  stripes: z.strictObject({ colors: colorPair, count: integer(1, 128), angleDegrees: finite.min(-360).max(360) }).optional(),
  gradient: z.strictObject({ colors: colorPair, axis: z.enum(["x", "y", "z"]) }).optional(),
  edgeLight: z.strictObject({ color, strength: finite.min(0).max(4), power: finite.min(.5).max(16) }).optional(),
  specular: z.strictObject({ strength: finite.min(0).max(4), shininess: finite.min(1).max(1024) }).optional(),
  reflection: z.strictObject({ strength: unit, sky: color, horizon: color, ground: color }).optional(),
  wireframe: z.strictObject({ color, width: finite.min(.25).max(16), divisions: z.tuple([integer(1, 256), integer(1, 256)]), fill: z.boolean() }).optional(),
  // Polish (2026-10-23), all optional.
  /** GGX specular width (0 glossy … 1 matte) instead of Blinn-Phong shininess; also blurs the studio reflection. */
  roughness: unit.optional(),
  /** Texture sampling for clipId: nearest, bilinear or trilinear mipmaps, with or without the texture's alpha (alpha draws blend back to front; faces a uvMode leaves untextured are then not drawn, so a thin "front" box is a textured card). */
  texture: z.strictObject({ filter: z.enum(["nearest", "bilinear", "mipmap"]), alpha: z.boolean() }).optional(),
  /** Grid lines for grid: true — cells per face (or [u, v]), line width in output pixels at 1080 wide, optional colour and fade-out by camera distance. */
  gridStyle: z.strictObject({ cells: z.union([integer(1, 512), z.tuple([integer(1, 512), integer(1, 512)])]), lineWidthPx: finite.min(.25).max(16), color: color.optional(),
    fade: z.strictObject({ start: finite.min(0).max(200), end: finite.min(0).max(200) }).refine(f => f.end > f.start, { message: "格線淡出結束距離需大於開始距離" }).optional() }).optional(),
  /** Key-light shadows (scene light.shadow): cast defaults to opaque draws, receive to lit materials. */
  castShadow: z.boolean().optional(), receiveShadow: z.boolean().optional(),
}).refine(m => [m.clipId, m.stripes, m.gradient].filter(v => v !== undefined).length <= 1 && !(m.grid && (m.stripes || m.gradient || m.wireframe)),
  { message: "3D 材質只能有一種底色來源（影片、條紋或漸層），格線不可與條紋／漸層／線框並用" })
  .refine(m => !m.texture || m.clipId !== undefined, { message: "材質取樣設定需搭配影片／圖片材質", path: ["texture"] })
  .refine(m => !m.gridStyle || m.grid === true, { message: "格線樣式需搭配 grid: true", path: ["gridStyle"] });
export const mesh3dObjectSchema = z.strictObject({
  id: z.string().min(1).max(80), name: z.string().min(1).max(100), geometry: mesh3dGeometrySchema,
  material: mesh3dMaterialSchema,
  pose, keyframes: z.array(z.strictObject({ time: finite.nonnegative(), pose, easing })).max(16),
});
export const mesh3dSegmentSchema = z.strictObject({
  id: z.string().min(1).max(80), name: z.string().min(1).max(120), timelineStart: finite.nonnegative(), duration: finite.positive().max(600),
  camera, cameraKeyframes: z.array(z.strictObject({ time: finite.nonnegative(), camera, easing })).max(16),
  objects: z.array(mesh3dObjectSchema).min(1).max(128),
});
/** Scene post effects, applied once per rendered frame (renderMesh3dFrame). Radii are fractions of the frame height. */
export const mesh3dPostSchema = z.strictObject({
  bloom: z.strictObject({ threshold: finite.min(0).max(4), strength: finite.min(0).max(4), radius: finite.min(.005).max(.3) }).optional(),
  dof: z.strictObject({ focusDistance: finite.min(.05).max(200), aperture: finite.min(0).max(.05) }).optional(),
  motionBlur: z.strictObject({ shutterSeconds: finite.positive().max(.1), samples: integer(2, 16) }).optional(),
  fisheye: z.strictObject({ strength: finite.min(-.5).max(1) }).optional(),
  vignette: z.strictObject({ strength: unit, softness: finite.min(.05).max(1) }).optional(),
  /** Polish: screen-space ambient occlusion of lit materials; radius in world units. */
  ao: z.strictObject({ strength: unit, radius: finite.min(.01).max(10) }).optional(),
});
export const mesh3dSceneSchema = z.strictObject({
  schema: z.literal("editkin.mesh-scene/v1"), enabled: z.boolean(),
  background: z.strictObject({ color, gridColor: color, spacing: finite.min(24).max(200), grid: z.boolean(),
    radial: z.strictObject({ color, center: z.tuple([unit, unit]), radius: finite.min(.05).max(3), strength: unit }).optional() }),
  light: z.strictObject({ direction: vector, ambient: finite.min(0).max(1), intensity: finite.min(0).max(2),
    fill: z.strictObject({ direction: vector, intensity: finite.min(0).max(2), color }).optional(),
    hemisphere: z.strictObject({ sky: color, ground: color, intensity: finite.min(0).max(2) }).optional(),
    /** Polish: angular radius (degrees) of the key light as an area light — softer specular and terminator. */
    size: finite.min(0).max(45).optional(),
    /** Polish: the key light sits at direction × distance from the world origin (a sphere light of angular radius `size`): light falls off across large faces and highlights take its shape. */
    distance: finite.min(.5).max(200).optional(),
    /** Polish: soft key-light shadows. softness = angular radius in degrees (penumbra grows with the occluder distance). */
    shadow: z.strictObject({ strength: unit, softness: finite.min(0).max(30), mapSize: integer(256, 4096).optional() }).optional() }),
  segments: z.array(mesh3dSegmentSchema).min(1).max(16),
  overlaysV1: mesh3dOverlaysV1Schema.optional(),
  post: mesh3dPostSchema.optional(),
});
export type Mesh3dScene = z.infer<typeof mesh3dSceneSchema>;
export type Mesh3dSegment = z.infer<typeof mesh3dSegmentSchema>;
export type Mesh3dObject = z.infer<typeof mesh3dObjectSchema>;
export type Mesh3dPose = Mesh3dObject["pose"];
export type Mesh3dCamera = Mesh3dSegment["camera"];
export type Mesh3dGeometry = Mesh3dObject["geometry"];
export type Mesh3dMaterial = Mesh3dObject["material"];
export type Mesh3dPost = z.infer<typeof mesh3dPostSchema>;
export type Mesh3dEasing = typeof MESH3D_EASINGS[number];
export type Mesh3dTubeSetGeometryV1 = Extract<Mesh3dGeometry, { kind: "tube_set" }>;
/**
 * The renderer's per-frame budgets (mesh3dFramePlan MESH3D_MAX_OBJECTS / _TEXTURES / _SCENE_TRIANGLES), for validators that
 * must not load the renderer. A frame draws one segment: its objects, its decoded textures (material and overlay clips)
 * and the triangles of its built geometry.
 */
export const MESH3D_SCENE_BUDGET_V1 = Object.freeze({ objects: 128, textures: 16, triangles: 200_000 });

function mix(a: number, b: number, t: number) { return a + (b - a) * t; }
function vectorMix(a: number[], b: number[], t: number): [number, number, number] { return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]; }
function sample<T>(initial: T, keys: { time: number; easing: string }[], time: number, get: (index: number) => T, interpolate: (a: T, b: T, t: number) => T): T {
  let previous = initial, previousTime = 0;
  for (let i = 0; i < keys.length; i++) {
    const next = keys[i];
    if (time < next.time) {
      const amount = Math.max(0, Math.min(1, (time - previousTime) / Math.max(1e-9, next.time - previousTime)));
      const t = next.easing === "hold" ? 0 : next.easing === "smooth" ? amount * amount * (3 - 2 * amount)
        : next.easing === "easeIn" ? amount * amount : next.easing === "easeOut" ? 1 - (1 - amount) * (1 - amount) : amount;
      return interpolate(previous, get(i), t);
    }
    previous = get(i); previousTime = next.time;
  }
  return previous;
}
export function mesh3dPoseAt(object: Mesh3dObject, time: number): Mesh3dPose {
  return sample(object.pose, object.keyframes, time, i => object.keyframes[i].pose, (a, b, t) => ({ position: vectorMix(a.position, b.position, t), rotationDegrees: vectorMix(a.rotationDegrees, b.rotationDegrees, t), scale: vectorMix(a.scale, b.scale, t) }));
}
type TubeSet = Extract<Mesh3dGeometry, { kind: "tube_set" }>;
type TubeWindow = [number, number];
const tubeWindow = (reveal: TubeSet["polylines"][number]["reveal"]): TubeWindow => reveal === undefined ? [0, 1] : typeof reveal === "number" ? [0, reveal] : [reveal[0], reveal[1]];
const animatedTube = (geometry: Mesh3dGeometry): geometry is TubeSet => geometry.kind === "tube_set" && Boolean(geometry.growthKeyframes?.length || geometry.polylines.some(p => p.revealKeyframes?.length));
/**
 * The geometry an object draws at a segment-local time: its own spec, except a tube_set with growthKeyframes or
 * revealKeyframes, whose growth and reveal windows are sampled like a pose (same easings) into a still spec. Every
 * other kind (and a still tube_set) returns the very same object.
 */
export function mesh3dGeometryAtV1(object: Mesh3dObject, time: number): Mesh3dGeometry {
  const geometry = object.geometry;
  if (!animatedTube(geometry)) return geometry;
  const { growthKeyframes, ...still } = geometry, growthKeys = growthKeyframes ?? [];
  return { ...still, growth: growthKeys.length ? sample(geometry.growth ?? 1, growthKeys, time, i => growthKeys[i].growth, mix) : geometry.growth,
    polylines: geometry.polylines.map(polyline => {
      if (!polyline.revealKeyframes?.length) return polyline;
      const { revealKeyframes: keys, ...line } = polyline;
      return { ...line, reveal: sample(tubeWindow(polyline.reveal), keys, time, i => tubeWindow(keys[i].reveal), (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)] as TubeWindow) };
    }) };
}
/**
 * A tube_set at its largest extent over time, where it has the most triangles: the largest growth it reaches (its
 * value and every keyframe; easings never overshoot) and each animated window widened to cover all its keyframes.
 * Other kinds (and a still tube_set) unchanged.
 */
export function mesh3dGeometryPeakV1(geometry: Mesh3dGeometry): Mesh3dGeometry {
  if (!animatedTube(geometry)) return geometry;
  const { growthKeyframes, ...still } = geometry;
  return { ...still, growth: Math.max(geometry.growth ?? 1, ...(growthKeyframes ?? []).map(k => k.growth)),
    polylines: geometry.polylines.map(polyline => {
      if (!polyline.revealKeyframes?.length) return polyline;
      const { revealKeyframes: keys, ...line } = polyline, windows = [tubeWindow(polyline.reveal), ...keys.map(k => tubeWindow(k.reveal))];
      return { ...line, reveal: [Math.min(...windows.map(w => w[0])), Math.max(...windows.map(w => w[1]))] as TubeWindow };
    }) };
}
export function mesh3dCameraAt(segment: Mesh3dSegment, time: number): Mesh3dCamera {
  return sample(segment.camera, segment.cameraKeyframes, time, i => segment.cameraKeyframes[i].camera, (a, b, t) => ({ position: vectorMix(a.position, b.position, t), target: vectorMix(a.target, b.target, t), verticalFovDegrees: mix(a.verticalFovDegrees, b.verticalFovDegrees, t), near: mix(a.near, b.near, t), far: mix(a.far, b.far, t),
    ...(a.roll !== undefined || b.roll !== undefined ? { roll: mix(a.roll ?? 0, b.roll ?? 0, t) } : {}) }));
}
